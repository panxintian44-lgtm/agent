import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import worker, { RiskConversationService } from "../dist/risk-worker.mjs";
import { RiskCloudStore, hash } from "../store.mjs";

const require = createRequire(import.meta.url);
const { ReviewWorkflowStore } = require("../../../../chenchen/integrations/review-workflow.js");
const { buildRiskHandoffPackage } = require("../../../../chenchen/integrations/risk-handoff.js");
const { verifyOwnerRequest } = require("../../../../chenchen/integrations/owner-bridge.js");
const ENV = { RISK_CONVERSATION_API_KEY: "synthetic-conversation-key-24-chars", CORE_AGENT_API_KEY: "synthetic-core-machine-key-24-chars",
  RISK_SERVICE_HMAC_SECRET: "synthetic-hmac-secret-never-live", RISK_REVIEWER_ID: "synthetic-fixed-risk-owner",
  CORE_AGENT_BASE_URL: "https://core.synthetic.test", REQUIRE_TRUSTED_ACTORS: "true", REQUIRE_RISK_REVIEWER: "true", RISK_MODEL_CALLS_ENABLED: "false" };
function storage(t) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const control = { syncFails: false, auditFails: false, syncCalls: 0 };
  return { control, storage: { sql: { exec(query, ...bindings) {
    if (control.auditFails && query.startsWith("INSERT INTO risk_events")) throw new Error("synthetic audit storage failure");
    const statement = db.prepare(query);
    return query.startsWith("SELECT") ? statement.all(...bindings) : (statement.run(...bindings), []);
  } }, async sync() { control.syncCalls++; if (control.syncFails) throw new Error("synthetic flush failure"); } } };
}
function fixture(t, overrides = {}) {
  const f = storage(t), env = { ...ENV, ...overrides };
  const service = new RiskConversationService({ storage: f.storage }, env);
  return { ...f, env, service };
}
const request = (route, data, env = ENV) => new Request("https://risk.synthetic.test" + route, {
  method: data === undefined ? "GET" : "POST", headers: { "X-Risk-Conversation-Key": env.RISK_CONVERSATION_API_KEY, ...(data === undefined ? {} : { "Content-Type": "application/json" }) },
  ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
const payload = (id = `cloud-test-${randomUUID()}`) => ({ question: "我想投资2000元，但下月还要交房租。", idempotency_key: id,
  daily_finance_yuan: { cash_yuan: "10000.00", amount_yuan: "2000.00", fees_yuan: "0.00", holds_yuan: "0.00", floor_yuan: "0.00", purpose_yuan: "4000.00", due_yuan: "4000.00", due_date: "2099-11-01", purpose_label: "房租", facts_confirmed: true, purpose_confirmed: true } });
function modelCore(t, options = {}) {
  const calls = [];
  const core = new ReviewWorkflowStore({ modelRunner: async input => {
    const proposal = { proposed_action: "HOLD_FOR_REVIEW", action_reason: "Synthetic fixture only", risk_level: "medium" };
    return { run_id: `synthetic-cloud-run-${randomUUID()}`, status: "PROPOSED", source: "model", input: { kind: input.kind, input_sha256: "a".repeat(64) },
      model_response: { call_succeeded: true, model: "SYNTHETIC_TEST_DOUBLE_NOT_LIVE", provider_response_id: null, proposal, raw_text: JSON.stringify(proposal) },
      audit: { audit_id: `synthetic-cloud-audit-${randomUUID()}`, events: [] } };
  } });
  t.mock.method(globalThis, "fetch", async (url, init = {}) => {
    const route = new URL(url).pathname;
    calls.push(route);
    assert.equal(new Headers(init.headers).get("X-Core-Agent-Key"), ENV.CORE_AGENT_API_KEY);
    let response;
    if (route === "/api/review") response = await core.start(JSON.parse(init.body));
    else if (route.endsWith("/risk-handoff")) response = buildRiskHandoffPackage(core.getByRunId(decodeURIComponent(route.split("/")[3])));
    else if (route.startsWith("/api/review/task/")) response = core.getByTaskId(decodeURIComponent(route.slice("/api/review/task/".length)));
    else if (route === "/api/review/risk-callback") {
      if (options.loseCallback) throw new Error("synthetic callback response lost");
      const body = JSON.parse(init.body);
      const auth = await verifyOwnerRequest({ owner: "risk", body, headers: new Headers(init.headers), env: ENV });
      response = await core.receiveRiskCallback(body, auth);
    } else throw new Error("Unexpected synthetic route");
    return Response.json(response);
  });
  return { calls, core };
}

test("public health reports actual build source and does not claim deployment or approval", async () => {
  const response = await worker.fetch(new Request("https://risk.synthetic.test/health"), {});
  const body = await response.json();
  assert.match(body.source_commit, /^[a-f0-9]{40}$/);
  assert.equal(typeof body.source_dirty, "boolean");
  assert.equal(body.deployment_id, null);
  assert.equal(body.formal_joint_acceptance, false);
  assert.equal(body.user_isolation_verified, false);
  assert.equal(body.scope, "SINGLE_SERVICE_SYNTHETIC");
  assert.equal(body.core_owner_bridge_receiver, false);
  assert.equal(body.simulation_callback_http, false);
  assert.equal(body.execution_allowed, false);
  assert.ok(!JSON.stringify(body).includes("PR27"));
});
test("missing auth and browser-origin requests never forward to a Durable Object", async () => {
  let calls = 0;
  const env = { ...ENV, RISK_CONVERSATIONS: { get() { calls++; throw new Error("must not forward"); } } };
  const missing = await worker.fetch(new Request("https://risk.synthetic.test/api/status"), env);
  assert.equal(missing.status, 401);
  const origin = request("/api/status"); origin.headers.set("Origin", "https://browser.synthetic.test");
  assert.equal((await worker.fetch(origin, env)).status, 403);
  assert.equal(calls, 0);
});
test("unconfigured durable storage and unsupported owner-bridge direction fail explicitly", async () => {
  assert.equal((await worker.fetch(request("/api/status"), ENV)).status, 503);
  const response = await worker.fetch(request("/api/risk-handoff", { adapter_version: "owner-bridge.v1" }), ENV);
  assert.equal(response.status, 501);
  assert.equal((await response.json()).error.code, "OWNER_BRIDGE_RECEIVER_NOT_IMPLEMENTED");
});
test("assessment reuses deterministic risk, journals evidence and does not call model or callback", async t => {
  const f = fixture(t);
  let calls = 0; t.mock.method(globalThis, "fetch", async () => { calls++; throw new Error("must not call"); });
  const input = payload(), response = await f.service.fetch(request("/api/assess", input));
  assert.equal(response.status, 200);
  const value = await response.json();
  assert.equal(value.decision_source, "PROGRAM_ONLY");
  assert.equal(value.risk_result.decision, "ALLOW");
  assert.equal(value.risk_advice.unified_assessment.validation_status, "VALID");
  assert.equal(value.executed, false);
  assert.equal(calls, 0);
  const replay = await (await f.service.fetch(request("/api/assess", input))).json();
  assert.equal(replay.replayed, true);
  const conflict = await f.service.fetch(request("/api/assess", { ...input, question: "changed" }));
  assert.equal(conflict.status, 409);
  assert.equal(f.service.store.events.length, 1);
  assert.ok(f.control.syncCalls > 0);
});
test("assessment rejects injected control fields without changing permissions", async t => {
  const f = fixture(t);
  const result = await f.service.fetch(request("/api/assess", { ...payload(), capability: "SIMULATION_ONLY", approved: true }));
  assert.equal(result.status, 422);
  assert.equal((await result.json()).error.code, "UNTRUSTED_CONTROL_FIELD");
  assert.equal(Object.keys(f.service.store.data.requests).length, 0);
});
test("model calls stay disabled until the service flag is explicitly enabled", async t => {
  const f = fixture(t); let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; });
  const result = await f.service.fetch(request("/api/review", payload()));
  assert.equal(result.status, 423);
  assert.equal((await result.json()).error.code, "MODEL_CALLS_DISABLED");
  assert.equal(calls, 0);
});
test("status describes machine configuration without claiming user/account isolation", async t => {
  const f = fixture(t);
  const response = await f.service.fetch(request("/api/status"));
  const status = await response.json();
  assert.equal(status.configured, true);
  assert.equal(status.scope, "SINGLE_SERVICE_SYNTHETIC");
  assert.equal(status.user_isolation_verified, false);
  assert.equal(status.end_user_identity_verified, false);
  assert.equal(status.core_connection_verified, false);
});
for (const [label, override, expected] of [
  ["missing signature", { RISK_SERVICE_HMAC_SECRET: undefined }, "TRUSTED_CORE_CONFIGURATION_REQUIRED"],
  ["compatibility secret without primary", { RISK_SERVICE_HMAC_SECRET: undefined, RISK_HMAC_SECRET: "synthetic-legacy-secret-not-live" }, "TRUSTED_CORE_CONFIGURATION_REQUIRED"],
  ["missing reviewer", { RISK_REVIEWER_ID: undefined }, "STRICT_IDENTITY_CONFIGURATION_REQUIRED"],
  ["disabled strict policy", { REQUIRE_RISK_REVIEWER: "false" }, "STRICT_IDENTITY_CONFIGURATION_REQUIRED"]
]) test(`enabled review rejects ${label} without external calls`, async t => {
  const f = fixture(t, { ...override, RISK_MODEL_CALLS_ENABLED: "true" }); let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; });
  const result = await f.service.fetch(request("/api/review", payload()));
  assert.equal(result.status, 503);
  assert.equal((await result.json()).error.code, expected);
  assert.equal(calls, 0);
});

for (const reviewer of ["x".repeat(201), " padded-owner", "owner\u0000suffix", "owner\u007fsuffix"]) {
  test(`cloud reviewer configuration rejects the Core-invalid identity ${JSON.stringify(reviewer)}`, async t => {
    const f = fixture(t, { RISK_MODEL_CALLS_ENABLED: "true", RISK_REVIEWER_ID: reviewer });
    let calls = 0;
    t.mock.method(globalThis, "fetch", async () => { calls++; throw new Error("must not call Core"); });
    const status = await (await f.service.fetch(request("/api/status"))).json();
    assert.equal(status.configured, false);
    assert.equal(status.fixed_reviewer_configured, false);
    const response = await f.service.fetch(request("/api/review", payload()));
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, "STRICT_IDENTITY_CONFIGURATION_REQUIRED");
    assert.equal(calls, 0);
  });
}

test("cloud and Core fixed reviewer configuration share the 200-character boundary", async t => {
  const f = fixture(t, { RISK_REVIEWER_ID: "x".repeat(200) });
  const status = await (await f.service.fetch(request("/api/status"))).json();
  assert.equal(status.configured, true);
  assert.equal(status.fixed_reviewer_configured, true);
});
test("SQLite audit insert failure never reports assessment success", async t => {
  const f = fixture(t); f.control.auditFails = true;
  const response = await f.service.fetch(request("/api/assess", payload()));
  assert.equal(response.status, 503);
  assert.equal((await response.json()).execution_allowed, false);
  assert.equal(f.service.store.events.length, 0);
});
test("durability failure blocks outgoing model traffic and poisons later requests", async t => {
  const f = fixture(t, { RISK_MODEL_CALLS_ENABLED: "true" }); f.control.syncFails = true; let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; });
  const response = await f.service.fetch(request("/api/review", payload()));
  assert.equal(response.status, 503);
  assert.equal(calls, 0);
  assert.equal((await response.json()).execution_allowed, false);
  const next = await f.service.fetch(request("/api/assess", payload()));
  assert.equal((await next.json()).error.code, "STORAGE_RECONCILIATION_REQUIRED");
});
test("a one-time flush failure blocks already queued reviews before any external call", async t => {
  const f = fixture(t, { RISK_MODEL_CALLS_ENABLED: "true" });
  let flushCalls = 0, externalCalls = 0;
  f.storage.sync = async () => { if (++flushCalls === 1) throw new Error("synthetic one-time flush failure"); };
  t.mock.method(globalThis, "fetch", async () => { externalCalls++; return Response.json({}); });
  const first = f.service.fetch(request("/api/review", payload("queued-first-review")));
  const second = f.service.fetch(request("/api/review", payload("queued-second-review")));
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(externalCalls, 0);
  assert.equal(firstResult.status, 503);
  assert.equal(secondResult.status, 503);
  assert.equal((await secondResult.json()).error.code, "STORAGE_RECONCILIATION_REQUIRED");
  assert.equal(flushCalls, 1);
  assert.equal(Object.keys(f.service.store.data.requests).length, 1);
});
test("restart converts unfinished requests to UNKNOWN and prevents replay", t => {
  const f = storage(t), first = new RiskCloudStore(f.storage);
  first.begin("synthetic-request", "fingerprint");
  first.audit("synthetic-request", "INTENT", { execution_allowed: false });
  const restarted = new RiskCloudStore(f.storage);
  assert.equal(restarted.data.requests["synthetic-request"].status, "UNKNOWN");
  assert.throws(() => restarted.begin("synthetic-request", "fingerprint"), { code: "REQUEST_RECONCILIATION_REQUIRED" });
  assert.equal(restarted.events.length, 1);
});
test("tampered audit chain prevents store startup", t => {
  const f = storage(t), first = new RiskCloudStore(f.storage);
  first.audit("synthetic-request", "INTENT", { execution_allowed: false });
  f.storage.sql.exec("INSERT INTO risk_events (body) VALUES (?)", JSON.stringify({ event_id: "forged", previous_hash: "wrong", event_hash: "wrong" }));
  assert.throws(() => new RiskCloudStore(f.storage), { code: "AUDIT_CHAIN_INVALID" });
});
test("built Worker reuses signed readonly callback and keeps task/hash/audit bound", async t => {
  const f = fixture(t, { RISK_MODEL_CALLS_ENABLED: "true" }), { calls, core } = modelCore(t);
  const input = payload(), response = await f.service.fetch(request("/api/review", input));
  const out = await response.json();
  assert.equal(response.status, 200, JSON.stringify(out));
  assert.equal(out.model.name, "SYNTHETIC_TEST_DOUBLE_NOT_LIVE");
  assert.equal(out.risk_callback.status, "RECORDED");
  assert.equal(out.capability, "REVIEW_ONLY");
  assert.equal(out.execution_allowed, false);
  assert.equal(out.audit.core_task_id, out.task_id);
  assert.equal(out.risk_decision.task_id, out.task_id);
  assert.equal(out.risk_decision.proposal_sha256, out.proposal_sha256);
  assert.ok(calls.includes("/api/review/risk-callback"));
  await assert.rejects(core.simulate({ task_id: out.task_id, proposal_sha256: out.proposal_sha256 }), error => ["EXECUTION_BLOCKED", "SIMULATION_CAPABILITY_REQUIRED"].includes(error.code));
  const count = calls.length;
  assert.equal((await (await f.service.fetch(request("/api/review", input))).json()).replayed, true);
  assert.equal(calls.length, count);
});
test("callback result unknown remains UNKNOWN, never retries or reports execution", async t => {
  const f = fixture(t, { RISK_MODEL_CALLS_ENABLED: "true" }), { calls } = modelCore(t, { loseCallback: true });
  const input = payload(), response = await f.service.fetch(request("/api/review", input));
  const out = await response.json();
  assert.equal(out.risk_callback.status, "UNKNOWN");
  assert.equal(out.executed, false);
  const key = hash({ actor: "finance-lab-cloud-validation", requestToken: input.idempotency_key });
  assert.equal(f.service.store.data.requests[key].status, "UNKNOWN");
  const count = calls.length;
  const replay = await f.service.fetch(request("/api/review", input));
  assert.equal(replay.status, 409);
  assert.equal(calls.length, count);
});
