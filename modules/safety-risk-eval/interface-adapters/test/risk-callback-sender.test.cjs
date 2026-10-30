"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { ReviewWorkflowStore } = require("../../../../chenchen/integrations/review-workflow.js");
const { buildRiskHandoffPackage } = require("../../../../chenchen/integrations/risk-handoff.js");
const { verifyOwnerRequest } = require("../../../../chenchen/integrations/owner-bridge.js");
const { buildRiskCallbackDraft, extractCoreBinding } = require("../risk-callback.cjs");
const { sendRiskCallback, sendSimulationCallback, CallbackSenderError, MAX_RESPONSE_BYTES } = require("../risk-callback-sender.cjs");

const CONFIG = Object.freeze({ baseUrl: "https://core.synthetic.invalid", apiKey: "synthetic-core-api-key", hmacSecret: "synthetic-risk-owner-secret", reviewer: "synthetic-server-risk-owner", timeoutMs: 2000 });

async function fixture(decision = "ALLOW", capability = "REVIEW_ONLY") {
  const store = new ReviewWorkflowStore({ modelRunner: async input => ({
    run_id: "synthetic-run-" + randomUUID(), source: "model", status: "PROPOSED",
    input: { kind: input.kind, input_sha256: "a".repeat(64) },
    model_response: { call_succeeded: true, model: "synthetic-contract-test-double", provider_response_id: null,
      proposal: { proposed_action: "HOLD_FOR_REVIEW", action_reason: "Check synthetic rent reserve", risk_level: "medium" } },
    audit: { audit_id: "synthetic-audit-" + randomUUID(), events: [] }
  }) });
  const record = await store.start({ kind: "bill", text: "Synthetic rent and tuition budget", requested_action: "Review allocation only",
    policy_version: "synthetic-policy.v1", capability, action_parameters: { amount: 8000, currency: "CNY" } });
  const handoff = buildRiskHandoffPackage(record);
  const risk = { risk_check_id: "synthetic-check-1", decision, check_complete: decision !== "ERROR", checked_at: "2026-10-21T13:00:00Z",
    policy_version: "synthetic-policy.v1", core_binding: extractCoreBinding(handoff), local_task_id: "synthetic-local-task-1",
    reasons: decision === "ALLOW" ? [] : [{ rule_id: "D01", code: "SYNTHETIC_" + decision, message_zh: "虚构测试原因", status: decision }] };
  const draft = buildRiskCallbackDraft({ handoff, risk_result: risk, reviewer: CONFIG.reviewer });
  const intents = [], outcomes = [], requests = [];
  const current = () => ({ handoff: buildRiskHandoffPackage(store.getByTaskId(record.task_id)), risk_check_id: risk.risk_check_id,
    policy_version: risk.policy_version, checked_at: risk.checked_at, versions_current: true });
  const realCoreFetch = async (url, options) => {
    requests.push({ url, options });
    assert.equal(url, CONFIG.baseUrl + "/api/review/risk-callback");
    assert.equal(options.method, "POST"); assert.equal(options.redirect, "manual");
    assert.equal(options.headers["X-Core-Agent-Key"], CONFIG.apiKey);
    const callback = JSON.parse(options.body);
    const auth = await verifyOwnerRequest({ owner: "risk", body: callback, headers: new Headers(options.headers),
      env: { RISK_SERVICE_HMAC_SECRET: CONFIG.hmacSecret, REQUIRE_TRUSTED_ACTORS: "true" } });
    const receipt = await store.receiveRiskCallback(callback, auth);
    return Response.json(receipt);
  };
  return { store, record, handoff, draft, risk, intents, outcomes, requests, current, realCoreFetch,
    args: { draft, loadCurrent: async () => current(), persistIntent: async row => { intents.push(row); },
      persistOutcome: async row => { outcomes.push(row); }, config: { ...CONFIG }, fetchImpl: realCoreFetch } };
}

for (const [risk, core, status] of [["ALLOW", "APPROVE", "PENDING_APPROVAL"], ["REVIEW", "REQUEST_MORE_INFO", "PENDING_RISK"], ["BLOCK", "REJECT", "REJECTED"]]) {
  test(`${risk}: real Core authenticates signed callback and remains non-executing`, async () => {
    const f = await fixture(risk), before = structuredClone(f.draft);
    const result = await sendRiskCallback(f.args);
    assert.equal(result.status, "RECORDED"); assert.equal(result.execution_allowed, false);
    assert.equal(result.receipt.decision, core); assert.equal(result.receipt.workflow_status, status);
    assert.equal(result.receipt.auth.verified, true); assert.equal(result.receipt.auth.mode, "HMAC_SHA256");
    assert.equal(f.requests.length, 1); assert.equal(f.intents.length, 1); assert.equal(f.outcomes.length, 1);
    assert.deepEqual(f.draft, before); assert.deepEqual(result.core_binding, f.risk.core_binding);
    assert.equal(f.store.getByTaskId(f.record.task_id).execution.simulation_allowed, false);
    if (risk === "REVIEW") assert.ok(result.required_next_actions.includes("AFTER_ACCEPTED_REQUEST_MORE_INFO_CREATE_NEW_CORE_TASK_AND_HANDOFF"));
    const auditText = JSON.stringify([f.intents, f.outcomes, result]);
    assert.ok(!auditText.includes(CONFIG.apiKey)); assert.ok(!auditText.includes(CONFIG.hmacSecret)); assert.ok(!auditText.includes("sha256="));
  });
}

test("ERROR never calls the network or records a business send intent", async () => {
  const f = await fixture("ERROR");
  await assert.rejects(sendRiskCallback(f.args), { code: "CALLBACK_NOT_SENDABLE", execution_allowed: false });
  assert.equal(f.requests.length, 0); assert.equal(f.intents.length, 0);
});

test("intent is durable before network, with complete callback and risk audit", async () => {
  const f = await fixture();
  f.args.fetchImpl = async (...args) => { assert.equal(f.intents.length, 1); assert.deepEqual(f.intents[0].callback, f.draft.callback); assert.deepEqual(f.intents[0].audit_context, f.draft.audit_context); return f.realCoreFetch(...args); };
  await sendRiskCallback(f.args);
});

for (const refusal of ["throw", "false", "object"]) test(`intent persistence ${refusal} blocks all HTTP`, async () => {
  const f = await fixture();
  f.args.persistIntent = async () => { if (refusal === "throw") throw new Error("storage " + CONFIG.apiKey); return refusal === "false" ? false : { persisted: false }; };
  await assert.rejects(sendRiskCallback(f.args), error => error.code === "CALLBACK_INTENT_NOT_DURABLE" && !error.message.includes(CONFIG.apiKey));
  assert.equal(f.requests.length, 0); assert.equal(f.store.getByTaskId(f.record.task_id).risk_decision, null);
});

for (const field of ["risk_check_id", "policy_version", "checked_at", "versions_current"]) test(`current ${field} mismatch blocks a stale callback`, async () => {
  const f = await fixture(); f.args.loadCurrent = async () => ({ ...f.current(), [field]: field === "versions_current" ? false : "changed" });
  await assert.rejects(sendRiskCallback(f.args), { code: "RISK_CHECK_STALE" }); assert.equal(f.requests.length, 0);
});

for (const field of ["handoff_id", "task_id", "request_id", "run_id", "audit_id", "proposal_sha256"]) test(`all six bindings rechecked: ${field}`, async () => {
  const f = await fixture(); f.draft.audit_context.core_binding[field] = "changed";
  await assert.rejects(sendRiskCallback(f.args), { code: "RISK_BINDING_MISMATCH" }); assert.equal(f.requests.length, 0);
});

test("state change while persisting intent is caught by the final current-state check", async () => {
  const f = await fixture(); let reads = 0;
  f.args.loadCurrent = async () => ({ ...f.current(), versions_current: ++reads === 1 });
  await assert.rejects(sendRiskCallback(f.args), { code: "RISK_CHECK_STALE" });
  assert.equal(reads, 2); assert.equal(f.intents.length, 1); assert.equal(f.requests.length, 0);
});

for (const mutation of ["decision", "reason", "reviewer", "execution_allowed", "extra", "undefined-extra"]) test(`mutated draft ${mutation} cannot gain dispatch authority`, async () => {
  const f = await fixture();
  if (mutation === "reviewer") f.draft.callback.reviewer = "forged-client-reviewer";
  else if (mutation === "execution_allowed") f.draft.execution_allowed = true;
  else if (mutation === "extra") f.draft.callback.approval = "APPROVED";
  else if (mutation === "undefined-extra") f.draft.callback.approval = undefined;
  else f.draft.callback[mutation] = mutation === "decision" ? "REJECT" : "forged reason";
  await assert.rejects(sendRiskCallback(f.args), error => ["CALLBACK_DRAFT_CHANGED", "RISK_REVIEWER_MISMATCH"].includes(error.code)); assert.equal(f.requests.length, 0);
});

for (const baseUrl of ["https://user:password@core.invalid", "https://core.invalid/path", "https://core.invalid?x=1", "https://core.invalid#fragment", "http://core.invalid", "file:///tmp/a", "http://127.0.0.1:4175"]) test(`reject unsafe server origin ${baseUrl}`, async () => {
  const f = await fixture(); f.args.config.baseUrl = baseUrl;
  await assert.rejects(sendRiskCallback(f.args), error => error instanceof CallbackSenderError); assert.equal(f.requests.length, 0);
});

test("explicit local HTTP is limited to loopback and keeps the fixed callback path", async () => {
  const f = await fixture(); f.args.config = { ...CONFIG, baseUrl: "http://127.0.0.1:4175", allowLocalHttp: true };
  f.args.fetchImpl = async (url, options) => { assert.equal(url, "http://127.0.0.1:4175/api/review/risk-callback"); return f.realCoreFetch(CONFIG.baseUrl + "/api/review/risk-callback", options); };
  assert.equal((await sendRiskCallback(f.args)).status, "RECORDED");
  const g = await fixture(); g.args.config = { ...CONFIG, baseUrl: "http://192.168.1.1", allowLocalHttp: true };
  await assert.rejects(sendRiskCallback(g.args), { code: "CALLBACK_HTTPS_REQUIRED" });
});

test("wrong HMAC fails real Core authentication and yields UNKNOWN without a fabricated decision", async () => {
  const f = await fixture(); f.args.config.hmacSecret = "synthetic-wrong-secret";
  const result = await sendRiskCallback(f.args);
  assert.equal(result.status, "UNKNOWN"); assert.equal(result.requires_reconciliation, true);
  assert.equal(f.store.getByTaskId(f.record.task_id).risk_decision, null); assert.equal(f.outcomes[0].status, "UNKNOWN");
});

test("network errors are redacted, durably UNKNOWN, and never retried", async () => {
  const f = await fixture(); let calls = 0;
  f.args.fetchImpl = async () => { calls++; throw new Error(CONFIG.apiKey + " " + CONFIG.hmacSecret); };
  const result = await sendRiskCallback(f.args);
  assert.equal(calls, 1); assert.equal(result.status, "UNKNOWN"); assert.equal(result.error.code, "CALLBACK_NETWORK_UNKNOWN");
  assert.equal(f.outcomes[0].status, "UNKNOWN"); assert.ok(!JSON.stringify(result).includes(CONFIG.apiKey));
});

test("a committed Core response lost in transit remains UNKNOWN and no resubmission occurs", async () => {
  const f = await fixture();
  f.args.fetchImpl = async (...args) => { await f.realCoreFetch(...args); throw new Error("connection lost after commit"); };
  const result = await sendRiskCallback(f.args);
  assert.equal(result.status, "UNKNOWN"); assert.equal(f.requests.length, 1);
  assert.equal(f.store.getByTaskId(f.record.task_id).risk_decision.decision, "APPROVE");
  await assert.rejects(sendRiskCallback(f.args), { code: "HANDOFF_NOT_PENDING" }); assert.equal(f.requests.length, 1);
});

test("timeout also bounds a fetch implementation that ignores AbortSignal", async () => {
  const f = await fixture(); f.args.config.timeoutMs = 10; f.args.fetchImpl = () => new Promise(() => {});
  const result = await sendRiskCallback(f.args);
  assert.equal(result.status, "UNKNOWN"); assert.equal(result.error.code, "CALLBACK_TIMEOUT"); assert.equal(f.outcomes.length, 1);
});

test("timeout remains active while waiting for an unfinished response body", async () => {
  const f = await fixture(); f.args.config.timeoutMs = 10;
  f.args.fetchImpl = async () => new Response(new ReadableStream({ start() {}, cancel() {} }), { headers: { "Content-Type": "application/json" } });
  assert.equal((await sendRiskCallback(f.args)).error.code, "CALLBACK_TIMEOUT");
});

for (const kind of ["redirect", "html", "invalid-json", "too-large", "unauthorized", "unverified", "mismatched-binding", "changed-proposal", "changed-decision", "changed-reviewer", "changed-callback", "forged-execution", "forged-handoff"]) test(`untrusted Core response ${kind} cannot report success`, async () => {
  const f = await fixture();
  f.args.fetchImpl = async (...args) => {
    if (kind === "redirect") return new Response(null, { status: 302, headers: { location: "https://other.invalid/" } });
    if (kind === "html") return new Response("<p>error</p>", { headers: { "Content-Type": "text/html" } });
    if (kind === "invalid-json") return new Response("{", { headers: { "Content-Type": "application/json" } });
    if (kind === "too-large") return new Response("x".repeat(MAX_RESPONSE_BYTES + 1), { headers: { "Content-Type": "application/json" } });
    if (kind === "unauthorized") return new Response(null, { status: 401 });
    const response = await f.realCoreFetch(...args), receipt = await response.json();
    if (kind === "unverified") receipt.workflow.risk_decision.auth.verified = false;
    if (kind === "mismatched-binding") receipt.workflow.audit.audit_id = "other-audit";
    if (kind === "changed-proposal") receipt.workflow.proposed_action.action_parameters.amount = 1;
    if (kind === "changed-decision") receipt.workflow.risk_decision.decision = "REJECT";
    if (kind === "changed-reviewer") receipt.workflow.risk_decision.reviewer = "forged-reviewer";
    if (kind === "changed-callback") receipt.workflow.risk_callback.request.reason = "forged-reason";
    if (kind === "forged-execution") receipt.workflow.execution.execution_allowed = true;
    if (kind === "forged-handoff") receipt.handoff = { task_id: "wrong-task", execution_allowed: false };
    return Response.json(receipt);
  };
  const result = await sendRiskCallback(f.args);
  assert.equal(result.status, "UNKNOWN"); assert.equal(result.execution_allowed, false); assert.equal(f.outcomes[0].status, "UNKNOWN");
});

test("success is withheld when persisting the verified receipt fails", async () => {
  const f = await fixture(); f.args.persistOutcome = async () => { throw new Error("storage failed " + CONFIG.apiKey); };
  const result = await sendRiskCallback(f.args);
  assert.equal(result.status, "UNKNOWN"); assert.equal(result.outcome_persisted, false);
  assert.equal(result.error.code, "CALLBACK_OUTCOME_NOT_DURABLE"); assert.equal(f.intents.length, 1);
  assert.equal(f.store.getByTaskId(f.record.task_id).status, "PENDING_APPROVAL"); assert.equal(f.requests.length, 1);
});

test("a genuine identical Core duplicate is verified without another risk decision", async () => {
  const f = await fixture();
  f.args.fetchImpl = async (...args) => { await f.realCoreFetch(...args); return f.realCoreFetch(...args); };
  const result = await sendRiskCallback(f.args);
  assert.equal(result.status, "DUPLICATE"); assert.equal(result.execution_allowed, false);
  const events = f.store.getByTaskId(f.record.task_id).audit.events;
  assert.equal(events.filter(row => row.event_type === "risk.callback.recorded").length, 1);
});

test("missing signer configuration never reaches the network", async () => {
  const f = await fixture(); delete f.args.config.hmacSecret;
  await assert.rejects(sendRiskCallback(f.args), { code: "CALLBACK_CONFIG_REQUIRED" }); assert.equal(f.requests.length, 0);
});

test("current state read failures are redacted and fail closed before a send intent", async () => {
  const f = await fixture(); f.args.loadCurrent = async () => { throw new Error(CONFIG.apiKey); };
  await assert.rejects(sendRiskCallback(f.args), { code: "CALLBACK_STATE_UNAVAILABLE" }); assert.equal(f.intents.length, 0); assert.equal(f.requests.length, 0);
});

test("explicit SIMULATION_ONLY sender completes the PAPER handoff without upgrading read-only tasks", async () => {
  const f = await fixture("ALLOW", "SIMULATION_ONLY");
  await assert.rejects(sendRiskCallback(f.args), { code: "CALLBACK_CAPABILITY_INVALID" });
  const result = await sendSimulationCallback(f.args);
  assert.equal(result.status, "RECORDED");
  assert.equal(result.capability, "SIMULATION_ONLY");
  assert.equal(result.execution_allowed, false);
  assert.equal(f.store.getByTaskId(f.record.task_id).status, "PENDING_APPROVAL");
  const binding = { task_id: f.record.task_id, proposal_sha256: f.record.proposed_action.proposal_sha256 };
  await f.store.decideApproval({ ...binding, decision: "APPROVE", approver: "synthetic-user", reason: "PAPER simulation only" });
  const simulated = await f.store.simulate(binding);
  assert.equal(simulated.status, "SIMULATED");
  assert.equal(simulated.execution.receipt.mode, "SIMULATED");
  assert.equal(simulated.execution.receipt.side_effects, false);
  assert.equal(simulated.execution.execution_allowed, false);
});
