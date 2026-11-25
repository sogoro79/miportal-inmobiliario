import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { notifyChatMessage, chatRecipient } from "../utils/chatEmail.js";
import { sendUnreadMessageReminders } from "../utils/unreadMessageReminders.js";
import { enviarCorreo } from "../utils/email.js";
import Mensaje from "../models/Mensaje.js";
import Conversacion from "../models/Conversacion.js";
import Usuario from "../models/Usuario.js";
import Propiedad from "../models/Propiedad.js";
import router from "../routes/chat.js";
const buyer = '507f1f77bcf86cd799439011', owner = '507f1f77bcf86cd799439022';
const cid = '507f1f77bcf86cd799439033';
const conv = { _id: cid, compradorId: buyer, anuncianteId: new mongoose.Types.ObjectId(owner), propiedadId: cid };
const clock = new Date('2026-11-25T12:00:00Z');
const old = new Date(+clock - 86400000);
const quiet = { warn() {} };
const user = id => ({ _id: id, email: `${id}@example.test`, nombre: '<name>' });
for (const [sender, recipient] of [[buyer, owner], [owner, buyer]]) {
  test(`immediate ${sender === buyer ? 'buyer → owner' : 'owner → buyer'} handles ObjectId/string and escaped excerpt`, async () => {
    const calls = [];
    assert.equal(await notifyChatMessage(conv, { userId: new mongoose.Types.ObjectId(sender), texto: '<secret>'.repeat(100) }, {
      UsuarioModel: { findById: async id => user(String(id)) }, PropiedadModel: { findById: async () => ({ titulo: '<home>' }) },
      send: async (...args) => { calls.push(args); return true; }
    }), true);
    assert.equal(calls[0][0], user(recipient).email);
    assert.notEqual(calls[0][0], user(sender).email);
    assert.match(calls[0][3].cta.url, new RegExp(`\\?id=${cid}$`));
    assert.doesNotMatch(calls[0][2], /<secret>|<name>|<home>/);
  });
}
test('invalid/self/missing sender is fail-safe', () => {
  for (const sender of [null, '', 'outsider']) assert.equal(chatRecipient(conv, sender), null);
  assert.equal(chatRecipient({ ...conv, compradorId: owner }, owner), null);
});
test('route persists message before email and Resend failure does not change response', async t => {
  const saved = []; const logs = [];
  t.mock.method(Conversacion, 'findById', async () => conv);
  t.mock.method(Usuario, 'findById', async id => ({ _id: id, activo: true }));
  t.mock.method(Mensaje, 'create', async data => { saved.push(data); return data; });
  // First lookup authorizes. Second (notification) fails after save, no network.
  let lookups = 0;
  t.mock.method(Usuario, 'findById', async id => { if (++lookups > 1) { assert.equal(saved.length, 1); throw Error('SECRET'); } return user(id); });
  t.mock.method(console, 'warn', (...args) => logs.push(args));
  const handler = router.stack.find(l => l.route?.path === '/conversaciones/:id/mensajes' && l.route.methods.post).route.stack.at(-1).handle;
  const res = { status(n) { this.statusCode = n; return this; }, json(body) { this.body = body; } };
  await handler({ params: { id: cid }, body: { texto: 'saved' }, user: { id: buyer } }, res);
  assert.equal(res.body.texto, 'saved'); assert.equal(saved.length, 1); assert.equal(res.statusCode, undefined);
  assert.doesNotMatch(JSON.stringify(logs), /SECRET|saved|example.test/);
});

// Tiny query double: evaluates actual predicates, including atomic lease exclusion.
function match(doc, filter) {
  return Object.entries(filter).every(([key, value]) => {
    if (key === '$or') return value.some(f => match(doc, f));
    const actual = doc[key];
    if (value === null) return actual == null;
    if (value && typeof value === 'object' && !(value instanceof Date)) {
      return Object.entries(value).every(([op, v]) => {
        if (op === '$in') return v.some(id => String(id) === String(actual));
        if (op === '$nin') return !(actual || []).some(id => v.some(x => String(id) === String(x)));
        if (op === '$lte') return actual != null && +actual <= +v;
        if (op === '$gt') return actual != null && +actual > +v;
        if (op === '$type') return actual instanceof Date;
        if (op === '$ne') return String(actual) !== String(v);
        throw Error(op);
      });
    }
    return String(actual) === String(value);
  });
}
const query = rows => ({ select() { return this; }, sort() { return this; }, limit(n) { rows = rows.slice(0,n); return this; }, lean: async () => rows });
function fixture(messages, { conversations = [conv], users = {}, sendResult = true } = {}) {
  messages = messages.map((m, i) => ({ _id: String(i), conversacionId: cid, userId: buyer, creado: old, leido: false, ...m }));
  conversations = conversations.map(c => ({ ...c }));
  const calls = [], logs = [], marks = [];
  const M = {
    aggregate: async stages => [...new Set(messages.filter(m => match(m, stages[0].$match)).map(m => m.conversacionId))].slice(0, stages[2].$limit).map(_id => ({ _id })),
    find: f => query(messages.filter(m => match(m, f))),
    updateMany: async (f, u) => { marks.push(f); messages.filter(m => match(m, f)).forEach(m => Object.assign(m, u.$set)); }
  };
  const C = {
    findOneAndUpdate: async (f, u) => { const c = conversations.find(c => match(c, f)); if (c) Object.assign(c, u.$set); return c; },
    exists: async f => conversations.some(c => match(c, f)),
    updateOne: async (f, u) => { const c = conversations.find(c => match(c, f)); if (c) for (const k of Object.keys(u.$unset)) delete c[k]; return { matchedCount: c ? 1 : 0 }; }
  };
  const deps = { MensajeModel: M, ConversacionModel: C, UsuarioModel: { findById: async id => id in users ? users[id] : user(id) },
    startSession: async () => ({ withTransaction: async fn => fn(), endSession: async () => {} }),
    now: () => clock, logger: { warn: (...a) => logs.push(a) },
    send: async (...args) => { calls.push(args); return typeof sendResult === 'function' ? sendResult(...args) : sendResult; } };
  return { run: () => sendUnreadMessageReminders(deps), messages, conversations, calls, marks, deps, logs };
}
for (const [name, message] of [
  ['read', { leido: true }], ['23h59', { creado: new Date(+clock - 86340000) }],
  ['already reminded', { reminderSentAt: old }], ['missing date', { creado: undefined }], ['invalid sender', { userId: 'outsider' }]
]) test(`${name}: no reminder`, async () => { const h = fixture([message]); await h.run(); assert.equal(h.calls.length, 0); });
test('24h legacy and multiple messages: one email, exact included messages marked, no repeat', async () => {
  const h = fixture([{}, {}, { creado: clock }]);
  await h.run(); assert.equal(h.calls.length, 1);
  assert.deepEqual(h.messages.map(m => Boolean(m.reminderSentAt)), [true, true, false]);
  await h.run(); assert.equal(h.calls.length, 1);
});
test('two conversations independent; failed send remains pending, others proceed', async () => {
  let count = 0;
  const h = fixture([{}, { conversacionId: 'second' }], { conversations: [conv, { ...conv, _id: 'second' }], sendResult: () => ++count > 1 });
  const result = await h.run(); assert.equal(result.failed, 1); assert.equal(result.sent, 1);
  assert.equal(h.calls.length, 2); assert.equal(h.messages[0].reminderSentAt, undefined);
  assert.ok(h.messages[1].reminderSentAt);
});
test('exception isolated and safely logged', async () => {
  const h = fixture([{}], { sendResult: () => { throw Error('SECRET user@example.test'); } });
  await h.run(); assert.equal(h.marks.length, 0); assert.doesNotMatch(JSON.stringify(h.logs), /SECRET|example.test/);
});
for (const recipient of [null, { activo: false, email: 'disabled@example.test' }, {}])
  test(`invalid recipient ${JSON.stringify(recipient)}`, async () => { const h = fixture([{}], { users: { [owner]: recipient } }); await h.run(); assert.equal(h.calls.length, 0); });
test('hidden/deleted/self conversations do not notify', async () => {
  for (const change of [{ hiddenFor: [owner] }, { deletedParticipants: [buyer] }, { compradorId: owner }]) {
    const h = fixture([{}], { conversations: [{ ...conv, ...change }] }); await h.run(); assert.equal(h.calls.length, 0);
  }
});
test('concurrent executions share atomic conversation claim', async () => {
  const h = fixture([{}, {}]); await Promise.all([h.run(), h.run()]); assert.equal(h.calls.length, 1);
});
test('message read during recipient lookup is excluded by final recheck', async () => {
  const h = fixture([{}]); h.deps.UsuarioModel.findById = async id => { h.messages[0].leido = true; return user(id); };
  await h.run(); assert.equal(h.calls.length, 0);
});
test('recipient reply reminders go to buyer; both directions send only one per execution', async () => {
  const h = fixture([{ userId: owner }, {}]); await h.run(); assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0][0], user(buyer).email); assert.equal(h.messages[1].reminderSentAt, undefined);
});
test('email helper confirms provider ID, rejects error responses and exceptions without secrets', async t => {
  const logs = []; t.mock.method(console, 'warn', (...a) => logs.push(a));
  for (const response of [{ error: { message: 'SECRET' } }, {}, { data: { id: 'ok' } }, null]) {
    const client = { emails: { send: async () => { if (!response) throw Error('SECRET'); return response; } } };
    assert.equal(await enviarCorreo('test@example.test', 'subject', 'body', { client }), Boolean(response?.data?.id));
  }
  assert.doesNotMatch(JSON.stringify(logs), /SECRET|example.test/);
});
test('unread count and marking route preserve their existing source of truth', async t => {
  t.mock.method(Conversacion, 'findById', async () => conv);
  t.mock.method(Conversacion, 'find', async () => [conv]);
  let updated;
  t.mock.method(Mensaje, 'updateMany', async (filter, update) => { updated = { filter, update }; });
  t.mock.method(Mensaje, 'countDocuments', async f => { assert.equal(f.leido, false); assert.equal(f.userId.$ne, owner); return 2; });
  const res = { status() { return this; }, json(body) { this.body = body; } };
  const route = (path, method) => router.stack.find(l => l.route?.path === path && l.route.methods[method]).route.stack.at(-1).handle;
  await route('/no-leidos/:userId', 'get')({ params: { userId: owner }, user: { id: owner } }, res);
  assert.deepEqual(res.body, { count: 2 });
  await route('/conversaciones/:id/leer', 'put')({ params: { id: cid }, user: { id: owner }, body: {} }, res);
  assert.deepEqual(updated.update, { leido: true }); assert.equal(updated.filter.userId.$ne, owner);
});
test('failed attempt retries the same batch with the same idempotency key', async () => {
  const h = fixture([{}], { sendResult: false }); await h.run(); await h.run();
  assert.equal(h.calls.length, 2); assert.equal(h.calls[0][3].idempotencyKey, h.calls[1][3].idempotencyKey);
  assert.equal(h.messages[0].reminderSentAt, undefined);
});
test('new messages arriving during send are not marked by the current batch', async () => {
  const h = fixture([{}]); h.deps.send = async () => { h.messages.push({ _id: 'late', conversacionId: cid, userId: buyer, leido: false, creado: clock }); return true; };
  await h.run(); assert.ok(h.messages[0].reminderSentAt); assert.equal(h.messages[1].reminderSentAt, undefined);
});
test('legacy Mongoose document accepts nullable reminder timestamp without changing read state', async () => {
  const m = new Mensaje({ conversacionId: cid, userId: buyer, texto: 'synthetic', leido: true });
  await m.validate(); assert.equal(m.reminderSentAt, null); assert.equal(m.leido, true);
  assert.equal(Conversacion.schema.path('reminderLockToken').options.select, false);
});
test('email rejection result remains a safe false for immediate notification', async () => {
  const logs = [];
  const result = await notifyChatMessage(conv, { userId: buyer, texto: 'PRIVATE' }, {
    UsuarioModel: { findById: async id => user(id) }, PropiedadModel: { findById: async () => null },
    send: async () => false, logger: { warn: (...args) => logs.push(args) }
  });
  assert.equal(result, false); assert.doesNotMatch(JSON.stringify(logs), /PRIVATE|example.test/);
});
test('expired conversation claim is recovered and finalized', async () => {
  const h = fixture([{}], { conversations: [{ ...conv, reminderLockToken: 'dead-worker', reminderLockUntil: new Date(+clock - 1) }] });
  await h.run(); assert.equal(h.calls.length, 1); assert.ok(h.messages[0].reminderSentAt);
  assert.equal(h.conversations[0].reminderLockToken, undefined);
});
test('active claim prevents delivery and is not released by another worker', async () => {
  const h = fixture([{}], { conversations: [{ ...conv, reminderLockToken: 'other', reminderLockUntil: new Date(+clock + 1000) }] });
  await h.run(); assert.equal(h.calls.length, 0); assert.equal(h.conversations[0].reminderLockToken, 'other');
});
test('email failure releases own claim without marking messages', async () => {
  const h = fixture([{}], { sendResult: false }); await h.run();
  assert.equal(h.conversations[0].reminderLockToken, undefined); assert.equal(h.messages[0].reminderSentAt, undefined);
});
test('lost claim during email cannot finalize or release the successor claim', async () => {
  const h = fixture([{}]);
  h.deps.send = async () => { h.conversations[0].reminderLockToken = 'successor'; return true; };
  const result = await h.run(); assert.equal(result.failed, 1); assert.equal(h.marks.length, 0);
  assert.equal(h.conversations[0].reminderLockToken, 'successor');
});
test('expired lease during email cannot finalize', async () => {
  const h = fixture([{}]);
  h.deps.send = async () => { h.conversations[0].reminderLockUntil = old; return true; };
  await h.run(); assert.equal(h.marks.length, 0); assert.equal(h.conversations[0].reminderLockToken, undefined);
});
test('idempotency keys separate conversations even for identical synthetic message IDs', async () => {
  const a = fixture([{}]); const b = fixture([{ conversacionId: 'different' }], { conversations: [{ ...conv, _id: 'different' }] });
  await a.run(); await b.run();
  assert.notEqual(a.calls[0][3].idempotencyKey, b.calls[0][3].idempotencyKey);
  assert.match(a.calls[0][3].idempotencyKey, /^chat-reminder-[a-f0-9]{64}$/);
});
test('Resend SDK options receive the idempotency key as the second argument', async () => {
  let options;
  await enviarCorreo('synthetic@example.test', 'subject', 'body', { idempotencyKey: 'synthetic-key',
    client: { emails: { send: async (_, opts) => { options = opts; return { data: { id: 'confirmed' } }; } } } });
  assert.deepEqual(options, { idempotencyKey: 'synthetic-key' });
});
test('messages and conversations hydrate without new legacy fields', () => {
  const m = Mensaje.hydrate({ conversacionId: cid, userId: buyer, texto: 'legacy', leido: false, creado: old });
  const c = Conversacion.hydrate(conv);
  assert.equal(m.reminderSentAt, null); assert.equal(m.leido, false); assert.equal(+m.creado, +old);
  assert.equal(c.reminderLockToken, undefined); assert.equal(c.reminderLockUntil, undefined);
});
test('bounded run processes at most 100 conversations and 500 messages per batch', async () => {
  const conversations = Array.from({ length: 101 }, (_, i) => ({ ...conv, _id: `c${i}` }));
  const h = fixture(conversations.map(c => ({ conversacionId: c._id })), { conversations });
  await h.run(); assert.equal(h.calls.length, 100);
  const batch = fixture(Array.from({ length: 501 }, () => ({})));
  await batch.run(); assert.equal(batch.calls.length, 1); assert.equal(batch.messages.filter(m => m.reminderSentAt).length, 500);
});
test('no eligible messages means no email, claim or transaction', async () => {
  const h = fixture([]); h.deps.startSession = async () => assert.fail('no transaction');
  assert.deepEqual(await h.run(), { sent: 0, failed: 0, skipped: 0 }); assert.equal(h.calls.length, 0);
});
test('finalization uses one transaction and closes its session on database error', async () => {
  const h = fixture([{}]); let ended = false; let inTransaction = false;
  const session = { withTransaction: async fn => { inTransaction = true; await fn(); }, endSession: async () => { ended = true; } };
  h.deps.startSession = async () => session;
  h.deps.MensajeModel.updateMany = async (_, __, options) => {
    assert.equal(inTransaction, true); assert.equal(options.session, session); throw Error('PRIVATE');
  };
  const result = await h.run(); assert.equal(result.failed, 1); assert.equal(ended, true);
  assert.equal(h.messages[0].reminderSentAt, undefined);
});
test('CLI exits successfully for isolated failures and disconnects; global failure is nonzero', async () => {
  const { main } = await import('../scripts/send-unread-message-reminders.js');
  for (const globalFailure of [false, true]) {
    let closed = 0; const runtime = { exitCode: 0 }; const logs = [];
    await main({ env: { MONGODB_URI: 'synthetic', RESEND_API_KEY: 'synthetic' }, runtime,
      db: { connect: async () => {}, disconnect: async () => { closed++; } },
      run: async () => { if (globalFailure) throw Error('SECRET'); return { sent: 1, failed: 1, skipped: 0 }; },
      logger: { log: (...a) => logs.push(a), warn: (...a) => logs.push(a) } });
    assert.equal(closed, 1); assert.equal(runtime.exitCode, globalFailure ? 1 : 0);
    assert.doesNotMatch(JSON.stringify(logs), /SECRET|synthetic/);
  }
});
