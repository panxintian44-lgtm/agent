"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { runPreflight } = require("../preflight.cjs");

const URLS = [
  "https://finance-lab-risk-bridge.realchenchenluo.workers.dev/health",
  "https://finance-lab-core-risk-validation.realchenchenluo.workers.dev/health",
  "https://xinlan-qwen38-share.lixjanus526.workers.dev/api/tinglan/status"
];
const fixtures = () => [
  { status: "ok", service: "risk-conversation", deployment: "CLOUD_VALIDATION", owner_source: "PR27-27bdefb", model_calls_enabled: false, joint_acceptance: false, execution_allowed: false },
  { status: "ok", service: "core-agent", contract_version: "investment-agent.v1", review_endpoint: "/api/review", docs: "/docs", model: { provider: "cloudflare_workers_ai", name: "synthetic-model-not-called", configured: false }, audit_storage: "durable_object" },
  { error: { code: "AUTHENTICATION_REQUIRED", message: "No session" }, execution_allowed: false }
];
function mockFetch(transform) {
  const calls = [], bodies = fixtures();
  const fetchImpl = async (url, options) => {
    const index = URLS.indexOf(url);
    assert.notEqual(index, -1, "No endpoint outside the fixed allowlist is requested");
    calls.push({ url, options });
    return transform ? transform(index, bodies[index], options) : Response.json(bodies[index], { status: index === 2 ? 401 : 200 });
  };
  return { calls, fetchImpl };
}
const hasCode = (result, code, serviceId) => result.blockers.some(row => row.code === code && (serviceId === undefined || row.service_id === serviceId));

test("only three fixed GET endpoints are probed without credentials, cookies, sessions or model calls", async () => {
  const fixture = mockFetch();
  const result = await runPreflight({ fetchImpl: fixture.fetchImpl });
  assert.deepEqual(fixture.calls.map(row => row.url), URLS);
  for (const { options } of fixture.calls) {
    assert.equal(options.method, "GET");
    assert.equal(options.redirect, "manual");
    assert.equal(options.credentials, "omit");
    assert.deepEqual(options.headers, { Accept: "application/json" });
    assert.equal(options.body, undefined);
  }
  assert.equal(result.schema_version, "risk-joint-preflight.v1");
  assert.equal(result.mode, "READ_ONLY_PREFLIGHT");
  assert.equal(new Date(result.checked_at).toISOString(), result.checked_at);
  assert.equal(result.real_model_calls, 0);
  assert.equal(result.joint_acceptance, false);
  assert.equal(result.execution_allowed, false);
  assert.deepEqual(result.services.map(row => row.status), ["HEALTH_ONLY", "HEALTH_ONLY", "AUTHENTICATION_REQUIRED"]);
  assert.equal(hasCode(result, "JOINT_ACCEPTANCE_NOT_PERFORMED"), true);
  assert.equal(hasCode(result, "RISK_MODEL_CALLS_DISABLED"), true);
  assert.equal(hasCode(result, "CORE_MODEL_NOT_CONFIGURED"), true);
  assert.equal(hasCode(result, "CHAT_SESSION_REQUIRED"), true);
});

test("reported health and model configuration never become full-chain success", async () => {
  const fixture = mockFetch((index, body) => {
    if (index === 0) { body.model_calls_enabled = true; body.joint_acceptance = true; }
    if (index === 1) body.model.configured = true;
    return Response.json(body, { status: index === 2 ? 401 : 200 });
  });
  const result = await runPreflight({ fetchImpl: fixture.fetchImpl });
  assert.equal(result.services[0].health_verified, true);
  assert.equal(result.services[1].health_verified, true);
  assert.equal(result.joint_acceptance, false);
  assert.equal(result.real_model_calls, 0);
  assert.equal(hasCode(result, "JOINT_ACCEPTANCE_CLAIM_NOT_VERIFIED"), true);
  assert.equal(hasCode(result, "CORE_CALLBACK_AUTH_NOT_PROBED"), true);
});

test("HTTP 200 alone cannot satisfy either health schema", async () => {
  const fixture = mockFetch(() => Response.json({ status: "ok" }));
  const result = await runPreflight({ fetchImpl: fixture.fetchImpl });
  assert.equal(result.services.every(row => row.health_verified === false), true);
  assert.equal(hasCode(result, "HEALTH_SCHEMA_INVALID", "risk_validation"), true);
  assert.equal(hasCode(result, "HEALTH_SCHEMA_INVALID", "core_validation"), true);
  assert.equal(hasCode(result, "CHAT_STATUS_NOT_VERIFIED"), true);
  assert.equal(result.joint_acceptance, false);
});

test("the chat 401 must contain the expected denial code and execution boundary", async () => {
  const fixture = mockFetch((index, body) => Response.json(index === 2 ? { error: { code: "OTHER" } } : body, { status: index === 2 ? 401 : 200 }));
  const result = await runPreflight({ fetchImpl: fixture.fetchImpl });
  assert.equal(result.services[2].status, "UNVERIFIED");
  assert.equal(hasCode(result, "CHAT_ACCESS_NOT_VERIFIED"), true);
});

test("a response that changes the execution boundary fails schema verification", async () => {
  const fixture = mockFetch((index, body) => {
    if (index === 0) body.execution_allowed = true;
    return Response.json(body, { status: index === 2 ? 401 : 200 });
  });
  const result = await runPreflight({ fetchImpl: fixture.fetchImpl });
  assert.equal(result.services[0].health_verified, false);
  assert.equal(hasCode(result, "HEALTH_SCHEMA_INVALID", "risk_validation"), true);
});

for (const status of [301, 302, 307, 308]) {
  test(`redirect ${status} is rejected and never followed`, async () => {
    const fixture = mockFetch(() => new Response(null, { status, headers: { Location: "https://untrusted.invalid/private" } }));
    const result = await runPreflight({ fetchImpl: fixture.fetchImpl });
    assert.equal(fixture.calls.length, 3);
    assert.equal(result.services.every(row => row.health_verified === false), true);
    assert.equal(result.blockers.filter(row => row.code === "REDIRECT_REJECTED").length, 3);
    assert.equal(JSON.stringify(result).includes("untrusted.invalid"), false);
  });
}

test("an already-followed response is rejected despite its final HTTP 200", async () => {
  const fixture = mockFetch((index, body) => {
    const response = Response.json(body);
    Object.defineProperty(response, "redirected", { value: true });
    return response;
  });
  const result = await runPreflight({ fetchImpl: fixture.fetchImpl });
  assert.equal(result.blockers.filter(row => row.code === "REDIRECT_REJECTED").length, 3);
});

test("a non-cooperative fetch still reaches the bounded timeout", async () => {
  const calls = [];
  const result = await runPreflight({ timeoutMs: 10, fetchImpl: (url, options) => { calls.push({ url, options }); return new Promise(() => {}); } });
  assert.equal(calls.length, 3);
  assert.equal(calls.every(row => row.options.signal.aborted), true);
  assert.equal(result.blockers.filter(row => row.code === "TIMEOUT").length, 3);
  assert.equal(result.joint_acceptance, false);
});

test("the timeout also bounds a stalled response body", async () => {
  const fixture = mockFetch(() => new Response(new ReadableStream({ start() {} }), { headers: { "Content-Type": "application/json" } }));
  const result = await runPreflight({ fetchImpl: fixture.fetchImpl, timeoutMs: 10 });
  assert.equal(result.blockers.filter(row => row.code === "TIMEOUT").length, 3);
});

test("network exceptions and private diagnostic text are redacted", async () => {
  const result = await runPreflight({ fetchImpl: async () => { throw new Error("Authorization: Bearer do-not-publish-this"); } });
  assert.equal(result.blockers.filter(row => row.code === "NETWORK_ERROR").length, 3);
  assert.equal(JSON.stringify(result).includes("do-not-publish-this"), false);
});

test("non-Error rejections and caller diagnostic codes cannot leak into the report", async () => {
  for (const thrown of [null, undefined, { probeCode: "private-token-must-not-appear" }]) {
    const result = await runPreflight({ fetchImpl: async () => { throw thrown; } });
    assert.equal(result.blockers.filter(row => row.code === "NETWORK_ERROR").length, 3);
    assert.equal(JSON.stringify(result).includes("private-token-must-not-appear"), false);
  }
});

test("raw response extras, headers and keys are never copied to the report", async () => {
  const fixture = mockFetch((index, body) => Response.json({ ...body, api_key: "do-not-publish-this", nested: { password: "private-value" } }, { status: index === 2 ? 401 : 200, headers: { "X-Private": "private-header" } }));
  const result = await runPreflight({ fetchImpl: fixture.fetchImpl });
  const serialized = JSON.stringify(result);
  for (const secret of ["do-not-publish-this", "private-value", "private-header", "api_key", "headers"]) assert.equal(serialized.includes(secret), false);
});

test("oversized JSON is rejected before parsing or reporting remote content", async () => {
  const fixture = mockFetch(() => Response.json({ padding: "x".repeat(65536) }));
  const result = await runPreflight({ fetchImpl: fixture.fetchImpl });
  assert.equal(result.blockers.filter(row => row.code === "RESPONSE_TOO_LARGE").length, 3);
});

test("non-JSON, malformed JSON and invalid UTF-8 responses fail closed", async () => {
  for (const make of [
    () => new Response("<html>error</html>", { headers: { "Content-Type": "text/html" } }),
    () => new Response("{invalid", { headers: { "Content-Type": "application/json" } }),
    () => new Response(new Uint8Array([0xff]), { headers: { "Content-Type": "application/json" } })
  ]) {
    const fixture = mockFetch(make);
    const result = await runPreflight({ fetchImpl: fixture.fetchImpl });
    assert.equal(result.blockers.filter(row => row.code === "INVALID_JSON_RESPONSE").length, 3);
  }
});

test("error HTTP status cannot be reported as a verified health response", async () => {
  const fixture = mockFetch((index, body) => Response.json(body, { status: 503 }));
  const result = await runPreflight({ fetchImpl: fixture.fetchImpl });
  assert.equal(result.services.every(row => row.health_verified === false), true);
  assert.equal(hasCode(result, "HTTP_NOT_OK", "risk_validation"), true);
});

test("callers cannot add endpoint overrides or unsupported timeout options", async () => {
  for (const options of [{ url: "https://untrusted.invalid" }, { endpoints: URLS }, { timeoutMs: 0 }, { timeoutMs: 60001 }, { timeoutMs: NaN }, { timeoutMs: "8" }, { fetchImpl: null }, null, []]) await assert.rejects(runPreflight(options), TypeError);
});

test("CLI help and unsupported arguments finish before any probe or output-file creation", () => {
  const script = path.join(__dirname, "../preflight.cjs");
  const help = spawnSync(process.execPath, [script, "--help"], { encoding: "utf8", timeout: 3000 });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Only three fixed public GET probes/);
  const wrong = spawnSync(process.execPath, [script, "--url", "https://untrusted.invalid"], { encoding: "utf8", timeout: 3000 });
  assert.equal(wrong.status, 1);
  assert.equal(wrong.stdout, "");
});
