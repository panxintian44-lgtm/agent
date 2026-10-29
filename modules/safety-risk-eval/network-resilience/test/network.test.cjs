"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createClient } = require("../network.js");

function fixture(fetchImpl, overrides = {}) {
  const activity = [], uncertain = [], calls = [];
  const client = createClient({
    isOnline: () => true, onActivity: info => activity.push(info), onUncertain: info => uncertain.push(info),
    fetchImpl: (route, options) => { calls.push({ route, options }); return fetchImpl(route, options); },
    ...overrides
  });
  return { client, activity, uncertain, calls };
}
function errorMatches(code, sent, reconcile) {
  return error => error.code === code && error.sent === sent && error.requiresReconciliation === reconcile && typeof error.message === "string" && /[\u3400-\u9fff]/.test(error.message);
}
function browserContext(extra = {}) {
  const sandbox = { Headers, Response, AbortController, TextDecoder, Uint8Array, setTimeout, clearTimeout, ...extra };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../network.js"), "utf8"), sandbox);
  return sandbox;
}

test("the browser UMD and CommonJS expose the same small client API", async () => {
  const browser = browserContext();
  assert.equal(typeof browser.RiskNetwork.createClient, "function");
  const client = browser.RiskNetwork.createClient({ fetchImpl: async () => Response.json({ result: "visible" }) });
  assert.deepEqual(JSON.parse(JSON.stringify(await client.requestJson("/api/status"))), { result: "visible" });
  assert.deepEqual(Object.keys(createClient({ fetchImpl: async () => Response.json({}) })), ["requestJson"]);
});

test("same-origin GET uses manual redirects and same-origin credentials without logging headers", async () => {
  const f = fixture(async () => Response.json({ ok: true }));
  assert.deepEqual(await f.client.requestJson("/api/status?access_token=do-not-log", { headers: { "X-Private": "private-header" } }), { ok: true });
  assert.equal(f.calls.length, 1);
  const options = f.calls[0].options;
  assert.equal(options.method, "GET");
  assert.equal(options.redirect, "manual");
  assert.equal(options.credentials, "same-origin");
  assert.equal(options.headers.get("X-Private"), "private-header");
  assert.equal(options.body, undefined);
  assert.deepEqual(f.activity.map(info => info.phase), ["started", "succeeded"]);
  assert.equal(f.activity.every(info => info.route === "/api/status"), true);
  const report = JSON.stringify(f.activity);
  assert.equal(report.includes("private-header"), false);
  assert.equal(report.includes("do-not-log"), false);
  assert.equal(f.uncertain.length, 0);
});

test("JSON writes preserve the caller's existing request key and do not invent or retry requests", async () => {
  const body = { task_id: "task-existing", idempotency_key: "existing-request-key", amount: "8000.00" };
  const f = fixture(async () => Response.json({ accepted: true }));
  assert.deepEqual(await f.client.requestJson("/api/action", { method: "POST", body }), { accepted: true });
  assert.equal(f.calls.length, 1);
  assert.deepEqual(JSON.parse(f.calls[0].options.body), body);
  assert.equal(f.calls[0].options.headers.get("Content-Type"), "application/json");
  assert.equal(f.activity.at(-1).task_id, "task-existing");
  assert.equal(f.activity.at(-1).idempotency_key, "existing-request-key");
  assert.equal(JSON.stringify(f.activity).includes("8000.00"), false);
  const withoutKey = fixture(async () => Response.json({ ok: true }));
  await withoutKey.client.requestJson("/api/action", { method: "POST", body: { amount: "1.00" } });
  assert.deepEqual(JSON.parse(withoutKey.calls[0].options.body), { amount: "1.00" });
  assert.equal("idempotency_key" in withoutKey.activity.at(-1), false);
});

test("already serialized JSON is sent once without double encoding", async () => {
  const body = '{"task_id":"task-one","idempotency_key":"exact-key"}';
  const f = fixture(async () => Response.json({ ok: true }));
  await f.client.requestJson("/api/action", { method: "POST", body });
  assert.equal(f.calls[0].options.body, body);
});

for (const route of ["https://untrusted.invalid/api", "http://localhost/api", "//untrusted.invalid/api", "/\\untrusted.invalid/api", "/%2funtrusted.invalid", "/%5cuntrusted.invalid", "api/status", "/api/status#secret", "/api/\nstatus"]) {
  test(`unsafe route is refused before sending: ${JSON.stringify(route)}`, async () => {
    const f = fixture(async () => { throw new Error("Must not send"); });
    await assert.rejects(f.client.requestJson(route, { method: "POST", body: {} }), errorMatches("INVALID_ROUTE", false, false));
    assert.equal(f.calls.length, 0);
    assert.equal(f.uncertain.length, 0);
  });
}

test("known offline state causes zero HTTP attempts and never reports a sent request", async () => {
  const f = fixture(async () => { throw new Error("Must not send"); }, { isOnline: () => false });
  await assert.rejects(f.client.requestJson("/api/action", { method: "POST", body: { task_id: "task-offline" } }), errorMatches("NETWORK_OFFLINE", false, false));
  assert.equal(f.calls.length, 0);
  assert.equal(f.uncertain.length, 0);
  assert.equal(f.activity.length, 1);
  assert.equal(f.activity[0].sent, false);
});

test("browser navigator offline state is respected by the default dependency", async () => {
  let calls = 0;
  const browser = browserContext({ navigator: { onLine: false } });
  const client = browser.RiskNetwork.createClient({ fetchImpl: async () => { calls++; return Response.json({}); } });
  await assert.rejects(client.requestJson("/api/action", { method: "POST", body: {} }), errorMatches("NETWORK_OFFLINE", false, false));
  assert.equal(calls, 0);
});

for (const method of ["GET", "POST"]) {
  test(`${method} deadline works even when fetch ignores AbortSignal`, async () => {
    const f = fixture(() => new Promise(() => {}));
    await assert.rejects(f.client.requestJson("/api/action", { method, timeoutMs: 10 }), errorMatches("NETWORK_TIMEOUT", true, method === "POST"));
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].options.signal.aborted, true);
    assert.equal(f.uncertain.length, method === "POST" ? 1 : 0);
    assert.deepEqual(f.activity.map(info => info.phase), ["started", "failed"]);
  });
  test(`${method} deadline also bounds a stalled body after HTTP 200`, async () => {
    const f = fixture(async () => new Response(new ReadableStream({ start() {} }), { headers: { "Content-Type": "application/json" } }));
    await assert.rejects(f.client.requestJson("/api/action", { method, timeoutMs: 10 }), errorMatches("NETWORK_TIMEOUT", true, method === "POST"));
    assert.equal(f.uncertain.length, method === "POST" ? 1 : 0);
  });
}

test("a lost write receipt is uncertain, linked to the original task, and never retried", async () => {
  let simulatedServerWrites = 0;
  const f = fixture(async () => { simulatedServerWrites++; throw new Error("private Authorization Bearer stack"); });
  await assert.rejects(f.client.requestJson("/api/action", { method: "POST", body: { task_id: "task-original", idempotency_key: "request-original", cash: 10000 } }), errorMatches("NETWORK_ERROR", true, true));
  assert.equal(simulatedServerWrites, 1);
  assert.equal(f.uncertain.length, 1);
  assert.equal(f.uncertain[0].task_id, "task-original");
  assert.equal(f.uncertain[0].idempotency_key, "request-original");
  const serialized = JSON.stringify(f.uncertain);
  for (const fragment of ["Authorization", "Bearer", "private", "cash", "10000"]) assert.equal(serialized.includes(fragment), false);
});

test("GET network failures cannot create an unknown-write event", async () => {
  const f = fixture(async () => { throw new Error("private network diagnostics"); });
  await assert.rejects(f.client.requestJson("/api/status"), errorMatches("NETWORK_ERROR", true, false));
  assert.equal(f.uncertain.length, 0);
});

for (const [status, code] of [[400, "HTTP_CLIENT_ERROR"], [401, "HTTP_UNAUTHORIZED"], [403, "HTTP_FORBIDDEN"], [409, "HTTP_CLIENT_ERROR"], [429, "HTTP_RATE_LIMITED"]]) {
  test(`HTTP ${status} explicitly rejects a write without reporting UNKNOWN`, async () => {
    const f = fixture(async () => Response.json({ error: { message: "请先核对当前权限。" } }, { status }));
    await assert.rejects(f.client.requestJson("/api/action", { method: "POST", body: {} }), errorMatches(code, true, false));
    assert.equal(f.uncertain.length, 0);
  });
}

test("an explicit 4xx remains a rejection when its JSON is broken or its error body stalls", async () => {
  for (const response of [
    () => new Response("private invalid response", { status: 401, headers: { "Content-Type": "application/json" } }),
    () => new Response(new ReadableStream({ start() {} }), { status: 401, headers: { "Content-Type": "application/json" } })
  ]) {
    const f = fixture(async () => response());
    await assert.rejects(f.client.requestJson("/api/action", { method: "POST", timeoutMs: 10 }), errorMatches("HTTP_UNAUTHORIZED", true, false));
    assert.equal(f.uncertain.length, 0);
  }
});

for (const status of [409, 429]) {
  test(`HTTP ${status} explicitly unknown business state keeps the original request frozen`, async () => {
    for (const body of [
      { status: "UNKNOWN", task_id: "task-returned" },
      { execution: { status: "UNKNOWN" }, task_id: "task-returned" },
      { requires_reconciliation: true, task_id: "task-returned" },
      { risk_callback: { status: "UNKNOWN" }, task_id: "task-returned" },
      { error: { code: "REQUEST_RECONCILIATION_REQUIRED" }, task_id: "task-returned" },
      { error: { requires_reconciliation: true }, task_id: "task-returned" }
    ]) {
      const f = fixture(async () => Response.json(body, { status }));
      await assert.rejects(f.client.requestJson("/api/action", { method: "POST", body: { idempotency_key: "keep-original-key" } }), error => error.sent === true && error.requiresReconciliation === true && error.httpStatus === status);
      assert.equal(f.uncertain.length, 1);
      assert.equal(f.uncertain[0].task_id, "task-returned");
      assert.equal(f.uncertain[0].idempotency_key, "keep-original-key");
      assert.equal(f.activity.at(-1).requiresReconciliation, true);
      assert.equal(f.calls.length, 1);
    }
  });
  test(`HTTP ${status} RUNNING keeps a pending operation without claiming that it failed`, async () => {
    const f = fixture(async () => Response.json({ status: "RUNNING", task_id: "task-running" }, { status }));
    await assert.rejects(f.client.requestJson("/api/action", { method: "POST", body: { task_id: "task-original" } }), error => error.requiresReconciliation === true && error.pending === true && error.message.includes("原请求仍在处理中"));
    assert.equal(f.uncertain[0].pending, true);
    assert.equal(f.uncertain[0].task_id, "task-original");
    assert.equal(f.calls.length, 1);
  });
}

test("GET 4xx business UNKNOWN does not invent an attempted write", async () => {
  const f = fixture(async () => Response.json({ status: "UNKNOWN", requires_reconciliation: true }, { status: 409 }));
  await assert.rejects(f.client.requestJson("/api/task/task-original"), errorMatches("HTTP_CLIENT_ERROR", true, false));
  assert.equal(f.uncertain.length, 0);
});

for (const method of ["GET", "POST"]) {
  for (const status of [500, 502, 503]) test(`${method} HTTP ${status} is explicit about write reconciliation`, async () => {
    const f = fixture(async () => Response.json({ error: { message: "内部故障：private-token" } }, { status }));
    await assert.rejects(f.client.requestJson("/api/action", { method }), error => errorMatches("HTTP_SERVER_ERROR", true, method === "POST")(error) && !error.message.includes("private-token"));
    assert.equal(f.uncertain.length, method === "POST" ? 1 : 0);
  });
}

test("invalid JSON and oversized write responses are uncertain without returning a fabricated result", async () => {
  for (const [make, code] of [
    [() => new Response("bad JSON", { headers: { "Content-Type": "application/json" } }), "INVALID_RESPONSE"],
    [() => new Response("<html>private</html>", { headers: { "Content-Type": "text/html" } }), "INVALID_RESPONSE"],
    [() => new Response(new Uint8Array([0xff]), { headers: { "Content-Type": "application/json" } }), "INVALID_RESPONSE"],
    [() => Response.json({ padding: "x".repeat(512 * 1024) }), "RESPONSE_TOO_LARGE"]
  ]) {
    const f = fixture(async () => make());
    await assert.rejects(f.client.requestJson("/api/action", { method: "POST" }), errorMatches(code, true, true));
    assert.equal(f.calls.length, 1);
    assert.equal(f.uncertain.length, 1);
  }
});

test("the exact 512 KiB JSON boundary is accepted and a byte more is refused", async () => {
  const text = '"' + "x".repeat(512 * 1024 - 2) + '"';
  const f = fixture(async () => new Response(text, { headers: { "Content-Type": "application/json" } }));
  assert.equal((await f.client.requestJson("/api/status")).length, 512 * 1024 - 2);
  const over = fixture(async () => new Response(text + " ", { headers: { "Content-Type": "application/json" } }));
  await assert.rejects(over.client.requestJson("/api/status"), errorMatches("RESPONSE_TOO_LARGE", true, false));
});

for (const method of ["GET", "POST"]) {
  test(`${method} redirects are refused without following the hostile location`, async () => {
    const f = fixture(async () => new Response(null, { status: 307, headers: { Location: "https://untrusted.invalid/private" } }));
    await assert.rejects(f.client.requestJson("/api/action", { method }), errorMatches("REDIRECT_REJECTED", true, method === "POST"));
    assert.equal(f.calls.length, 1);
    assert.equal(JSON.stringify(f.activity).includes("untrusted.invalid"), false);
  });
}

test("already-followed and opaque redirect responses cannot be treated as success", async () => {
  for (const property of ["redirected", "type"]) {
    const f = fixture(async () => {
      const response = Response.json({ ok: true });
      Object.defineProperty(response, property, { value: property === "type" ? "opaqueredirect" : true });
      return response;
    });
    await assert.rejects(f.client.requestJson("/api/action", { method: "POST" }), errorMatches("REDIRECT_REJECTED", true, true));
  }
});

test("server diagnostics are bounded and stacks, tokens and unknown English text stay private", async () => {
  for (const detail of ["Error: private stack", "内部异常\n at doWork(file.js:1)", "请联系管理员 token=private-value", "内部异常 https://private.invalid", "内部异常 <script>private</script>"]) {
    const f = fixture(async () => Response.json({ error: { message: detail } }, { status: 400 }));
    await assert.rejects(f.client.requestJson("/api/action", { method: "POST" }), error => error.code === "HTTP_CLIENT_ERROR" && !error.message.includes(detail) && !error.message.includes("private"));
  }
  const long = fixture(async () => Response.json({ error: { message: "需要核对".repeat(200) } }, { status: 400 }));
  await assert.rejects(long.client.requestJson("/api/action", { method: "POST" }), error => error.message.length < 220);
});

for (const state of ["UNKNOWN", "RUNNING"]) {
  for (const place of ["top", "execution"]) test(`HTTP 200 ${place} ${state} remains visible and prevents blind resubmission`, async () => {
    const data = { task_id: "task-returned", ...(place === "top" ? { status: state } : { execution: { status: state } }) };
    const f = fixture(async () => Response.json(data));
    const result = await f.client.requestJson("/api/action", { method: "POST", body: { idempotency_key: "request-kept" } });
    assert.deepEqual(result, data);
    assert.equal(f.uncertain.length, 1);
    assert.equal(f.uncertain[0].task_id, "task-returned");
    assert.equal(f.uncertain[0].idempotency_key, "request-kept");
    assert.equal(f.uncertain[0].code, state === "RUNNING" ? "SERVER_RESULT_PENDING" : "SERVER_RESULT_UNKNOWN");
    assert.equal(f.uncertain[0].pending, state === "RUNNING");
    assert.equal(f.activity.at(-1).requiresReconciliation, true);
    assert.equal(f.calls.length, 1);
  });
}

test("existing Risk callback UNKNOWN and nested task bindings preserve the original identifiers", async () => {
  const data = { input: { binding: { task_id: "task-response" } }, risk_callback: { status: "UNKNOWN" } };
  const f = fixture(async () => Response.json(data));
  assert.deepEqual(await f.client.requestJson("/api/action", { method: "POST", body: { input: { binding: { task_id: "task-original" } } } }), data);
  assert.equal(f.uncertain[0].task_id, "task-original");
  const returned = fixture(async () => Response.json(data));
  await returned.client.requestJson("/api/action", { method: "POST" });
  assert.equal(returned.uncertain[0].task_id, "task-response");
});

test("a GET query that reports a pending operation is not mistaken for another attempted write", async () => {
  const f = fixture(async () => Response.json({ status: "RUNNING", task_id: "task-one" }));
  assert.equal((await f.client.requestJson("/api/task/task-one")).status, "RUNNING");
  assert.equal(f.uncertain.length, 0);
});

test("observer exceptions do not replace a network outcome or trigger another write", async () => {
  const f = fixture(async () => { throw null; }, { onActivity: () => { throw new Error("private observer"); }, onUncertain: async () => { throw new Error("private async observer"); } });
  await assert.rejects(f.client.requestJson("/api/action", { method: "POST" }), errorMatches("NETWORK_ERROR", true, true));
  assert.equal(f.calls.length, 1);
  await new Promise(resolve => setTimeout(resolve, 1));
});

test("default read, write, model, and explicit deadlines are selected without real waiting", async () => {
  const scheduled = [];
  const browser = browserContext({ setTimeout: (callback, delay) => { scheduled.push(delay); return setTimeout(callback, 1); } });
  const client = browser.RiskNetwork.createClient({ fetchImpl: () => new Promise(() => {}) });
  for (const [route, options] of [["/api/status", {}], ["/api/confirm", { method: "POST" }], ["/api/safety/model-demo", { method: "POST" }], ["/api/review", { method: "POST" }], ["/api/action", { method: "POST", timeoutMs: 1234 }]]) await assert.rejects(client.requestJson(route, options), error => error.code === "NETWORK_TIMEOUT");
  assert.deepEqual(scheduled, [10000, 20000, 65000, 65000, 1234]);
});

test("client and request configuration errors are rejected before HTTP", async () => {
  for (const options of [null, [], { fetchImpl: null }, { isOnline: false }, { defaultReadTimeoutMs: 0 }, { defaultWriteTimeoutMs: "1000" }, { modelTimeoutMs: Infinity }, { onActivity: true }, { retry: 3 }]) assert.throws(() => createClient(options), TypeError);
  const f = fixture(async () => Response.json({}));
  for (const options of [null, [], { method: "TRACE" }, { method: "GET", body: {} }, { method: "POST", body: "broken JSON" }, { timeoutMs: -1 }, { signal: {} }]) await assert.rejects(f.client.requestJson("/api/action", options), errorMatches("INVALID_REQUEST", false, false));
  assert.equal(f.calls.length, 0);
});
