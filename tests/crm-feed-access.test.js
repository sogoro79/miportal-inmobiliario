import test from "node:test";
import assert from "node:assert/strict";
import { createFeedAccess, PROVIDER_BLOCKED, retryAfterMs } from "../utils/import/feedAccess.js";
import { fetchFeedXml, FeedFetchError } from "../utils/import/feedFetcher.js";
import { createImportBudget } from "../utils/import/importBudget.js";

const url = "https://feed.example.test/xml?key=synthetic-secret";
const read = { usuarioId: "user-a", feedType: "inmoweb", fresh: false };
const fail = (status, retryAfter) => Object.assign(new FeedFetchError("unsafe body must not escape", "BAD_STATUS"), { httpStatus: status, retryAfter });
function harness(options = {}) {
  let time = 1_700_000_000_000, calls = 0;
  const logs = [];
  const access = createFeedAccess({ now: () => time, log: event => logs.push(event),
    fetchXml: async () => { calls++; return { xml: `<xml>${calls}</xml>`, finalUrl: url, headers: { cookie: "secret" } }; }, ...options });
  return { access, logs, calls: () => calls, advance: ms => { time += ms; } };
}
for (const feedType of ["inmoweb", "generic_xml"]) test(`${feedType}: first read, cache hit and TTL expiry`, async () => {
  const h = harness();
  const a = await h.access(url, { ...read, feedType });
  assert.equal(h.calls(), 1);
  const b = await h.access(url, { ...read, feedType });
  assert.equal(b.cached, true); assert.equal(a.xml, b.xml); assert.equal(a.fetchedAt, b.fetchedAt);
  assert.equal(h.calls(), 1);
  assert.equal(b.headers, undefined); assert.equal(b.finalUrl, undefined);
  h.advance(300_000);
  assert.notEqual((await h.access(url, read)).xml, a.xml); assert.equal(h.calls(), 2);
});
test("owner and URL identity isolate captures and cooldowns", async () => {
  const h = harness();
  await h.access(url, read); await h.access(url, { ...read, usuarioId: "user-b" });
  await h.access(url + "-changed", read);
  assert.equal(h.calls(), 3);
  await assert.rejects(h.access(url, { fresh: false }), TypeError);
});
test("concurrent equivalent reads share one download", async () => {
  let finish, calls = 0;
  const h = harness({ fetchXml: () => { calls++; return new Promise(resolve => { finish = resolve; }); } });
  const a = h.access(url, read), b = h.access(url, read);
  await Promise.resolve();
  assert.equal(calls, 1); finish({ xml: "<xml/>" });
  assert.deepEqual(await a, await b);
});
test("fresh validation bypasses cache, waits for pending read then downloads again", async () => {
  let finish, calls = 0;
  const h = harness({ fetchXml: async () => { if (++calls === 1) return new Promise(resolve => { finish = resolve; }); return { xml: "new" }; } });
  const a = h.access(url, read), fresh = h.access(url, { ...read, fresh: true });
  await Promise.resolve();
  assert.equal(calls, 1); finish({ xml: "old" });
  assert.equal((await a).xml, "old"); assert.equal((await fresh).xml, "new"); assert.equal(calls, 2);
  await h.access(url, { ...read, fresh: true }); assert.equal(calls, 3);
});
for (const [status, duration, retryAfter] of [[403, 900_000], [429, 120_000, "120"], [503, 60_000]]) {
  test(`${status}: no retry, cooldown stops reads AND fresh downloads, then expires`, async () => {
    let calls = 0;
    const h = harness({ fetchXml: async () => { calls++; throw fail(status, retryAfter); } });
    await assert.rejects(h.access(url, read), { code: PROVIDER_BLOCKED });
    await assert.rejects(h.access(url, read), { code: PROVIDER_BLOCKED });
    await assert.rejects(h.access(url, { ...read, fresh: true }), { code: PROVIDER_BLOCKED });
    assert.equal(calls, 1); h.advance(duration);
    await assert.rejects(h.access(url, read), { code: PROVIDER_BLOCKED }); assert.equal(calls, 2);
    assert.equal(h.logs[0].cooldownMs, duration);
    assert.doesNotMatch(JSON.stringify(h.logs), /secret|https|cookie|key=|unsafe/);
  });
}
test("Retry-After supports HTTP date and safe fallback", () => {
  const now = Date.parse("2026-01-01T00:00:00Z");
  assert.equal(retryAfterMs("Thu, 01 Jan 2026 00:02:00 GMT", now), 120_000);
  for (const value of [undefined, "garbage", "-5", "0"]) assert.equal(retryAfterMs(value, now), 60_000);
});
test("timeouts are cooled down without automatic retries", async () => {
  let calls = 0;
  const h = harness({ fetchXml: async () => { calls++; throw new FeedFetchError("timeout", "FEED_TIMEOUT"); } });
  await Promise.all(Array.from({ length: 10 }, () => assert.rejects(h.access(url, read), { code: PROVIDER_BLOCKED })));
  assert.equal(calls, 1);
});
test("one cancelled reader does not cancel the shared download", async () => {
  let finish;
  const h = harness({ fetchXml: async (_url, options) => {
    assert.ok(options.signal); assert.ok(options.budget);
    return new Promise(resolve => { finish = resolve; });
  } });
  const controller = new AbortController();
  const a = h.access(url, { ...read, signal: controller.signal });
  const b = h.access(url, read);
  controller.abort(new Error("cancelled")); await assert.rejects(a, /cancelled/);
  finish({ xml: "ok" }); assert.equal((await b).xml, "ok");
});
test("cache and state capacity are bounded without evicting cooldowns", async () => {
  const h = harness({ maxCacheBytes: 1 });
  await h.access(url, read); await h.access(url, read); assert.equal(h.calls(), 2);
  const limited = harness({ maxEntries: 1, fetchXml: async () => { throw fail(403); } });
  await assert.rejects(limited.access(url, read), { code: PROVIDER_BLOCKED });
  await assert.rejects(limited.access(url + "2", read), { code: PROVIDER_BLOCKED });
});
test("HTTP metadata survives fetcher without retaining response body or headers in error", async () => {
  await assert.rejects(fetchFeedXml(url, { lookup: async () => [{ address: "8.8.8.8", family: 4 }],
    requestOnce: async () => ({ statusCode: 429, headers: { "Retry-After": "120", cookie: "secret" }, body: "sensitive html" })
  }), error => {
    assert.equal(error.httpStatus, 429); assert.equal(error.retryAfter, "120");
    assert.equal(error.headers, undefined); assert.equal(error.body, undefined); return true;
  });
});
test("fresh request retains import budget and does not fall back to stale cache on rejection", async () => {
  let calls = 0;
  const budget = createImportBudget();
  try {
    const h = harness({ fetchXml: async (_url, options) => {
      if (++calls === 1) return { xml: "old" };
      assert.equal(options.budget, budget); throw fail(403);
    } });
    await h.access(url, read);
    await assert.rejects(h.access(url, { ...read, fresh: true, budget }), { code: PROVIDER_BLOCKED });
    await assert.rejects(h.access(url, read), { code: PROVIDER_BLOCKED });
    assert.equal(calls, 2);
  } finally { budget.dispose(); }
});
