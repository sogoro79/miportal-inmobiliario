import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import jwt from 'jsonwebtoken';
import Propiedad from '../models/Propiedad.js';
import Usuario from '../models/Usuario.js';

process.env.JWT_SECRET = 'test-admin-propiedades';
process.env.RESEND_API_KEY = 're_test';
process.env.STRIPE_SECRET_KEY = 'sk_test';
const { default: router } = await import('../routes/admin.js');
const route = router.stack.find(layer => layer.route?.path === '/propiedades' && layer.route.methods.get).route;
const propietario = '507f1f77bcf86cd799439011';
const otro = '507f1f77bcf86cd799439012';
const legacy = { _id: propietario, nombre: 'Miguel' };
const crm = { _id: 'crm', usuarioId: propietario, visiblePublicamente: false, externalId: '123', titulo: 'CRM antigua' };
const manual = { _id: 'manual', usuarioId: propietario, visiblePublicamente: true };
const externas = Array.from({ length: 100 }, (_, i) => ({ _id: String(i), usuarioId: otro }));

async function listar(query, actor, t, registros = [...externas, manual, crm]) {
  t.mock.method(Usuario, 'findById', async () => actor);
  const find = t.mock.method(Propiedad, 'find', filtro => {
    let rows = registros.filter(p => !filtro.usuarioId || p.usuarioId === filtro.usuarioId);
    return {
      sort() { return this; },
      limit(n) { rows = rows.slice(0, n); return this; },
      then(resolve) { resolve(rows); }
    };
  });
  const token = jwt.sign({ id: actor._id }, process.env.JWT_SECRET);
  const req = { method: 'GET', query, headers: { authorization: 'Bearer ' + token } };
  const result = await new Promise((resolve, reject) => {
    const res = {
      code: 200,
      status(code) { this.code = code; return this; },
      json(body) { resolve({ code: this.code, body }); }
    };
    route.dispatch(req, res, reject);
  });
  return { ...result, find };
}

const admin = { _id: otro, role: 'admin' };
test('admin recupera solo las manuales y CRM del propietario legacy, también antiguas y ocultas', async t => {
  const { code, body } = await listar({ usuarioId: legacy._id }, admin, t);
  assert.equal(code, 200);
  assert.deepEqual(body, [manual, crm]);
});
test('el listado general mantiene su límite habitual', async t => {
  assert.deepEqual((await listar({}, admin, t)).body, externas);
});
for (const id of ['', 'inválido', [propietario], { $ne: null }]) {
  test('rechaza sin consultar un ObjectId inválido ' + JSON.stringify(id), async t => {
    const { code, find } = await listar({ usuarioId: id }, admin, t);
    assert.equal(code, 400);
    assert.equal(find.mock.callCount(), 0);
  });
}
test('un usuario sin permisos no puede filtrar', async t => {
  const { code, find } = await listar({ usuarioId: propietario }, legacy, t);
  assert.equal(code, 403);
  assert.equal(find.mock.callCount(), 0);
});
test('el menú abre la tabla del usuario, conserva sus acciones y permite quitar el filtro', async () => {
  const html = fs.readFileSync(new URL('../public/admin.html', import.meta.url), 'utf8');
  const elements = new Map();
  const document = {
    addEventListener() {},
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, { dataset: {}, scrollIntoView() {} });
      return elements.get(id);
    }
  };
  const ctx = vm.createContext({
    document, formatearPrecioPropiedad: () => "", localStorage: { getItem: () => null },
    window: { HomeClickLocation: { locationHtml: () => '' } },
    fetch: async url => {
      assert.equal(url, '/admin/propiedades?usuarioId=' + propietario);
      return { ok: true, json: async () => [crm] };
    },
    legacy, externas
  });
  const run = source => vm.runInContext(source, ctx);
  run(html.match(/<script>\s*(let adminToken[\s\S]*?)<\/script>/)[1]);
  run("todosLosUsuarios = [legacy]; propiedadesAdmin = externas; filtroRedesPropiedades = 'publicadas';");
  assert.match(run('renderMenuAccionesUsuario(legacy, false)'), /Ver publicaciones/);
  await run('verPublicacionesUsuario(legacy._id)');
  assert.equal(document.getElementById('nombreFiltroPropietario').textContent, 'Publicaciones de: Miguel');
  const rows = document.getElementById('tablaPropiedades');
  assert.match(rows.innerHTML, /editarPropiedadAdmin\('crm'\)/);
  assert.match(rows.innerHTML, /eliminarPropiedad\('crm'\)/);
  assert.equal(run("buscarPropiedadAdmin('crm').visiblePublicamente"), false);
  run("actualizarPropiedadEnListas('crm', { redesPublicadoCount: 1 })");
  assert.equal(run("buscarPropiedadAdmin('crm').redesPublicadoCount"), 1);
  run('quitarFiltroPropietario()');
  assert.equal(document.getElementById('filtroPropietario').hidden, true);
  assert.equal(run('propiedadesDeTabla().length'), 100);
  assert.doesNotMatch(rows.innerHTML, /CRM antigua/);
});
