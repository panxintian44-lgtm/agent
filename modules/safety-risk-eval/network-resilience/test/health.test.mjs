import assert from "node:assert/strict";
import test from "node:test";
import { createHealthMonitor } from "../health.mjs";

const CORE_URL = "https://personal-ai-fund-manager-core-agent.realchenchenluo.workers.dev/health";
const healthy = (configured = true) => ({
  status: "ok", service: "core-agent", contract_version: "investment-agent.v1",
  model: { provider: "TEST_DOUBLE", name: "not-called", configured }
});
const json = (value, options = {}) => new Response(JSON.stringify(value), {
  status: 200, headers: { "content-type": "application/json; charset=utf-8" }, ...options
});
function database(first = async () => ({ ok: 1 })) {
  const queries = [];
  return { queries, DB: { prepare(sql) {
    queries.push(sql);
    assert.equal(sql, "SELECT 1 AS ok");
    return { first, run() { assert.fail("Health must not write database rows."); } };
  }, batch() { assert.fail("Health must not write batches."); },
  exec() { assert.fail("Health must not execute database changes."); } } };
}
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

test("read-only health uses the pinned GET and exact safe envelope", async () => {
  const db = database();
  let calls = 0;
  const inspect = createHealthMonitor({ now: () => Date.parse("2026-10-22T06:00:00Z"), fetchImpl: async (url, options) => {
    calls++;
    assert.equal(url, CORE_URL);
    assert.equal(options.method, "GET");
    assert.equal(options.redirect, "manual");
    assert.equal(options.credentials, "omit");
    assert.equal(options.body, undefined);
    assert.deepEqual(options.headers, { Accept: "application/json" });
    return json({ ...healthy(), unexpected_private_value: "must-not-be-returned" });
  } });
  const result = await inspect({ DB: db.DB,
    get SESSION() { assert.fail("Health must not inspect or create sessions."); },
    get CORE_AGENT_API_KEY() { assert.fail("Health must not read service credentials."); },
    get AI() { assert.fail("Health must not inspect or call model bindings."); }
  });
  assert.deepEqual(result, {
    schema_version: "risk-service-health.v1", checked_at: "2026-10-22T06:00:00.000Z", overall: "UP",
    services: { workbench: { status: "UP" }, storage: { status: "UP" },
      core: { status: "UP", model_configured: true, inference_probe: "NOT_RUN" } },
    execution_allowed: false, business_acceptance: "NOT_VERIFIED"
  });
  assert.deepEqual(db.queries, ["SELECT 1 AS ok"]);
  assert.equal(calls, 1);
  assert.equal(JSON.stringify(result).includes("must-not-be-returned"), false);
});

test("Core reachability, model configuration and business readiness stay separate", async () => {
  for (const configured of [true, false, null, "true"]) {
    const inspect = createHealthMonitor({ fetchImpl: async () => json(healthy(configured)) });
    const result = await inspect({ DB: database().DB });
    assert.equal(result.services.core.status, "UP");
    assert.equal(result.services.core.model_configured, typeof configured === "boolean" ? configured : null);
    assert.equal(result.services.core.inference_probe, "NOT_RUN");
    assert.equal(result.business_acceptance, "NOT_VERIFIED");
    assert.equal(result.execution_allowed, false);
  }
  const inspect = createHealthMonitor({ fetchImpl: async () => json({ status: "ok", service: "core-agent", contract_version: "investment-agent.v1" }) });
  assert.equal((await inspect()).services.core.model_configured, null);
});

test("missing and failed storage never prevent independent Core diagnostics", async () => {
  const inspect = createHealthMonitor({ fetchImpl: async () => json(healthy()) });
  const missing = await inspect();
  assert.equal(missing.overall, "DEGRADED");
  assert.equal(missing.services.storage.status, "NOT_CONFIGURED");
  assert.equal(missing.services.core.status, "UP");
  for (const DB of [{}, database(async () => { throw new Error("private storage connection string"); }).DB,
    database(async () => ({ ok: "1" })).DB, database(async () => null).DB]) {
    const result = await inspect({ DB });
    assert.equal(result.overall, "DEGRADED");
    assert.equal(result.services.storage.status, "UNAVAILABLE");
    assert.equal(result.services.core.status, "UP");
    assert.equal(JSON.stringify(result).includes("private storage"), false);
  }
});

test("Core connection failure is redacted and storage remains independently UP", async () => {
  const inspect = createHealthMonitor({ fetchImpl: async () => { throw new Error("private host and token=secret"); } });
  const result = await inspect({ DB: database().DB });
  assert.equal(result.overall, "DEGRADED");
  assert.equal(result.services.workbench.status, "UP");
  assert.equal(result.services.storage.status, "UP");
  assert.deepEqual(result.services.core, { status: "UNAVAILABLE", model_configured: null, inference_probe: "NOT_RUN" });
  assert.equal(JSON.stringify(result).includes("token"), false);
});

test("redirects, HTTP errors and other services cannot report Core UP", async () => {
  const cases = [
    () => new Response(null, { status: 302, headers: { Location: "https://other.invalid" } }),
    () => json(healthy(), { status: 503 }),
    () => { const response = json(healthy()); return { status: 200, redirected: true, headers: response.headers, body: response.body }; },
    () => json({ ...healthy(), status: "error" }),
    () => json({ ...healthy(), service: "other-service" }),
    () => json({ ...healthy(), contract_version: "unknown.v2" }),
    () => json([healthy()]),
    () => new Response(JSON.stringify(healthy()), { headers: { "content-type": "text/html" } }),
    () => new Response("not-json", { headers: { "content-type": "application/json" } })
  ];
  for (const makeResponse of cases) {
    const inspect = createHealthMonitor({ fetchImpl: async () => makeResponse() });
    assert.equal((await inspect({ DB: database().DB })).services.core.status, "UNAVAILABLE");
  }
});

test("Core response is limited to 32 KiB including chunked bodies", async () => {
  for (const makeResponse of [
    () => json({ ...healthy(), padding: "x".repeat(32768) }),
    () => new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new Uint8Array(20000));
      controller.enqueue(new Uint8Array(12769));
      controller.close();
    } }), { headers: { "content-type": "application/json" } }),
    () => json(healthy(), { headers: { "content-type": "application/json", "content-length": "32769" } }),
    () => json(healthy(), { headers: { "content-type": "application/json", "content-length": "invalid" } }),
    () => new Response(new Uint8Array([0xff, 0xfe]), { headers: { "content-type": "application/json" } })
  ]) {
    const inspect = createHealthMonitor({ fetchImpl: async () => makeResponse() });
    assert.equal((await inspect({ DB: database().DB })).services.core.status, "UNAVAILABLE");
  }
});

test("hanging fetch is bounded even when the transport ignores AbortSignal", async () => {
  let signal;
  const inspect = createHealthMonitor({ timeoutMs: 15, fetchImpl: (_, options) => {
    signal = options.signal;
    return new Promise(() => {});
  } });
  const started = Date.now();
  const result = await inspect({ DB: database().DB });
  assert.ok(Date.now() - started < 1000);
  assert.equal(result.services.core.status, "UNAVAILABLE");
  assert.equal(signal.aborted, true);
  assert.equal(result.services.storage.status, "UP");
});

test("response body and cancellation share the fetch deadline", async () => {
  let cancelled = 0;
  const inspect = createHealthMonitor({ timeoutMs: 15, fetchImpl: async () => ({
    status: 200, redirected: false, headers: new Headers({ "content-type": "application/json" }),
    body: { getReader: () => ({ read: () => new Promise(() => {}), cancel: () => { cancelled++; return new Promise(() => {}); } }) }
  }) });
  const started = Date.now();
  assert.equal((await inspect({ DB: database().DB })).services.core.status, "UNAVAILABLE");
  assert.ok(Date.now() - started < 1000);
  assert.ok(cancelled >= 1);
});

test("slow storage is bounded without hiding Core status", async () => {
  const inspect = createHealthMonitor({ timeoutMs: 15, fetchImpl: async () => json(healthy(false)) });
  const started = Date.now();
  const result = await inspect({ DB: database(() => new Promise(() => {})).DB });
  assert.ok(Date.now() - started < 1000);
  assert.equal(result.services.storage.status, "UNAVAILABLE");
  assert.equal(result.services.core.status, "UP");
  assert.equal(result.services.core.model_configured, false);
});

test("concurrent callers share an in-flight probe and receive independent copies", async () => {
  const gate = deferred(), db = database();
  let calls = 0;
  const inspect = createHealthMonitor({ fetchImpl: async () => { calls++; await gate.promise; return json(healthy()); } });
  const pending = Array.from({ length: 8 }, () => inspect({ DB: db.DB }));
  await Promise.resolve();
  gate.resolve();
  const results = await Promise.all(pending);
  assert.equal(calls, 1);
  assert.equal(db.queries.length, 1);
  results[0].services.core.status = "POISONED";
  assert.equal(results[1].services.core.status, "UP");
  assert.equal((await inspect({ DB: db.DB })).services.core.status, "UP");
  assert.equal(calls, 1);
});

test("cache expires after its TTL and is isolated by storage binding", async () => {
  let tick = 1000, calls = 0;
  const db = database(), secondDb = database();
  const inspect = createHealthMonitor({ cacheTtlMs: 20000, now: () => tick, fetchImpl: async () => { calls++; return json(healthy()); } });
  const first = await inspect({ DB: db.DB });
  tick += 19999;
  assert.equal((await inspect({ DB: db.DB })).checked_at, first.checked_at);
  assert.equal(calls, 1);
  tick += 1;
  const fresh = await inspect({ DB: db.DB });
  assert.notEqual(fresh.checked_at, first.checked_at);
  assert.equal(calls, 2);
  await inspect({ DB: secondDb.DB });
  assert.equal(calls, 3);
  assert.equal(secondDb.queries.length, 1);
});

test("unavailable results are cached without background work and later recover", async () => {
  let tick = 0, calls = 0;
  const db = database();
  const inspect = createHealthMonitor({ now: () => tick, cacheTtlMs: 20, fetchImpl: async () => {
    calls++;
    if (calls === 1) throw new Error("offline");
    return json(healthy());
  } });
  assert.equal((await inspect({ DB: db.DB })).overall, "DEGRADED");
  tick = 19;
  assert.equal((await inspect({ DB: db.DB })).overall, "DEGRADED");
  assert.equal(calls, 1);
  tick = 20;
  assert.equal((await inspect({ DB: db.DB })).overall, "UP");
  assert.equal(calls, 2);
});
