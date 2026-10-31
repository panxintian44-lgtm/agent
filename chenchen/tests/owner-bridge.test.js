"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const ownerBridge = require("../integrations/owner-bridge");
const { ReviewWorkflowStore } = require("../integrations/review-workflow");

const proposal = {
  summary: "需要人工核对。",
  risk_level: "medium",
  proposed_action: "HOLD_FOR_REVIEW",
  action_reason: "模型只提出建议。",
  missing_information: [],
  evidence: ["synthetic fixture"]
};

function fakeReview(input) {
  return Promise.resolve({
    review_version: "model-review.v1",
    schema_version: "model-review.v1",
    run_id: "review-owner-" + input.task_id,
    request_id: input.request_id,
    task_id: input.task_id,
    status: "PROPOSED",
    source: "model",
    input: { schema_version: "model-review.v1", kind: input.kind, source: input.source, input_sha256: "a".repeat(64), session_id: input.session_id, data_mode: input.data_mode, execution_mode: input.execution_mode, capability: input.capability, risk_profile_version: input.risk_profile_version, policy_version: input.policy_version },
    model_response: { model: "synthetic-model", provider_response_id: "response-" + input.task_id, call_succeeded: true, proposal },
    audit: { audit_id: "audit-" + input.task_id, events: [] }
  });
}

function base() {
  return {
    request_id: "req-owner-001",
    kind: "bill",
    source: "synthetic-owner-bridge",
    text: "虚构账单：请交给统一 Risk 复核。",
    data_mode: "SYNTHETIC_REPLAY",
    execution_mode: "PAPER",
    capability: "REVIEW_ONLY",
    portfolio_snapshot_id: "snapshot-owner-001",
    risk_profile_version: "risk-profile.v1",
    policy_version: "policy.v1",
    memory_consent: false
  };
}

test("owner signatures are deterministic and reject tampering", async () => {
  const body = { z: 1, a: { d: 2, c: 3 } };
  const signature = await ownerBridge.signatureFor(body, "risk-secret");
  assert.equal(signature, await ownerBridge.signatureFor({ a: { c: 3, d: 2 }, z: 1 }, "risk-secret"));
  const auth = await ownerBridge.verifyOwnerRequest({ owner: "risk", body: { reviewer: "risk-001", ...body }, headers: { "x-risk-signature": await ownerBridge.signatureFor({ reviewer: "risk-001", ...body }, "risk-secret") }, env: { RISK_SERVICE_HMAC_SECRET: "risk-secret" } });
  assert.equal(auth.verified, true);
  await assert.rejects(ownerBridge.verifyOwnerRequest({ owner: "risk", body: { reviewer: "risk-001", ...body }, headers: { "x-risk-signature": "sha256=bad" }, env: { RISK_SERVICE_HMAC_SECRET: "risk-secret" } }), error => error.code === "OWNER_AUTH_INVALID");
});

test("Risk accepts only the fixed reviewer after a valid signature", async () => {
  const body = { reviewer: "risk-fixed", task_id: "synthetic-task" };
  const env = { RISK_SERVICE_HMAC_SECRET: "risk-secret", RISK_REVIEWER_ID: "risk-fixed",
    REQUIRE_TRUSTED_ACTORS: "true", REQUIRE_RISK_REVIEWER: "true" };
  const auth = await ownerBridge.verifyOwnerRequest({ owner: "risk", body,
    headers: { "X-Risk-Signature": await ownerBridge.signatureFor(body, env.RISK_SERVICE_HMAC_SECRET) }, env });
  assert.equal(auth.fixed_reviewer_verified, true);
  const wrong = { ...body, reviewer: "another-reviewer" };
  await assert.rejects(ownerBridge.verifyOwnerRequest({ owner: "risk", body: wrong,
    headers: { "X-Risk-Signature": await ownerBridge.signatureFor(wrong, env.RISK_SERVICE_HMAC_SECRET) }, env }),
  error => error.code === "OWNER_ACTOR_MISMATCH" && error.statusCode === 403);
});

test("Risk strict identity configuration fails closed without exposing secret values", async () => {
  const strictBase = { RISK_SERVICE_HMAC_SECRET: "risk-secret", REQUIRE_TRUSTED_ACTORS: "true", REQUIRE_RISK_REVIEWER: "true" };
  await assert.rejects(ownerBridge.verifyOwnerRequest({ owner: "risk", body: { reviewer: "risk-fixed" }, headers: {}, env: strictBase }),
    error => error.code === "OWNER_REVIEWER_NOT_CONFIGURED" && !JSON.stringify(error).includes("risk-secret"));
  await assert.rejects(ownerBridge.verifyOwnerRequest({ owner: "risk", body: { reviewer: "risk-fixed" }, headers: {}, env: { ...strictBase, RISK_REVIEWER_ID: " risk-fixed" } }),
    error => error.code === "OWNER_CONFIG_INVALID");
  await assert.rejects(ownerBridge.verifyOwnerRequest({ owner: "risk", body: { reviewer: "risk-fixed" }, headers: {}, env: { RISK_HMAC_SECRET: "legacy-secret", RISK_REVIEWER_ID: "risk-fixed", REQUIRE_TRUSTED_ACTORS: "true" } }),
    error => error.code === "OWNER_CONFIG_INVALID" && !JSON.stringify(error).includes("legacy-secret"));
  await assert.rejects(ownerBridge.verifyOwnerRequest({ owner: "risk", body: { reviewer: "risk-fixed" }, headers: {}, env: { RISK_SERVICE_HMAC_SECRET: "risk-secret", RISK_REVIEWER_ID: "risk-fixed", REQUIRE_RISK_REVIEWER: "sometimes" } }),
    error => error.code === "OWNER_CONFIG_INVALID");
});

test("owner configuration status reports names and readiness without secret contents", () => {
  const status = ownerBridge.ownerConfigurationStatus("risk", { RISK_SERVICE_HMAC_SECRET: "risk-secret", RISK_REVIEWER_ID: "risk-fixed", REQUIRE_TRUSTED_ACTORS: "true", REQUIRE_RISK_REVIEWER: "true" });
  assert.deepEqual(status, {
    owner: "risk", secret_configured: true, secret_name: "RISK_SERVICE_HMAC_SECRET", primary_secret_configured: true,
    compatibility_secret_configured: false, require_trusted_actors: true, require_risk_reviewer: true,
    reviewer_configured: true, configuration_error: null
  });
  assert.equal(JSON.stringify(status).includes("risk-secret"), false);
});

test("missing actor secrets remain visibly demo-only and can be made fail closed", async () => {
  const demo = await ownerBridge.verifyOwnerRequest({ owner: "approval", body: { approver: "demo-user" }, headers: {}, env: {} });
  assert.deepEqual({ mode: demo.mode, verified: demo.verified }, { mode: "DEMO_UNVERIFIED", verified: false });
  await assert.rejects(ownerBridge.verifyOwnerRequest({ owner: "approval", body: { approver: "demo-user" }, headers: {}, env: { REQUIRE_TRUSTED_ACTORS: "true" } }), error => error.code === "OWNER_AUTH_NOT_CONFIGURED");
});

test("Risk dispatch signs one handoff and records the upstream response", async () => {
  let request;
  const env = { RISK_SERVICE_URL: "https://risk.example/review", RISK_SERVICE_HMAC_SECRET: "risk-secret" };
  const response = await ownerBridge.dispatchRiskHandoff({ trace: { task_id: "task-1" }, handoff_id: "handoff-1" }, env, {
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify({ accepted: true }), { status: 202, headers: { "Content-Type": "application/json" } });
    }
  });
  assert.equal(response.upstream_status, 202);
  assert.equal(request.url, env.RISK_SERVICE_URL);
  assert.equal(request.options.headers["X-Core-Agent-Contract"], "risk-handoff.v1");
  assert.equal(request.options.headers["X-Core-Agent-Signature"], await ownerBridge.signatureFor(request.options.body, env.RISK_SERVICE_HMAC_SECRET));
});

test("Risk dispatch refuses to pretend delivery when the Owner is not configured", async () => {
  await assert.rejects(ownerBridge.dispatchRiskHandoff({ trace: { task_id: "task-1" } }, {}), error => error.code === "RISK_OWNER_NOT_CONFIGURED");
});

test("workflow dispatch stays auditable and retries only after a failed handoff", async () => {
  const store = new ReviewWorkflowStore({ modelRunner: fakeReview });
  const created = await store.start({ ...base(), capability: "SIMULATION_ONLY" });
  const request = { task_id: created.task_id, proposal_sha256: created.proposed_action.proposal_sha256 };
  const failedSender = async () => { const error = new Error("risk unavailable"); error.code = "OWNER_SERVICE_UNAVAILABLE"; error.statusCode = 503; throw error; };
  await assert.rejects(store.dispatchRiskHandoff(request, failedSender), error => error.code === "OWNER_SERVICE_UNAVAILABLE" && error.workflowRecord.risk_dispatch.status === "FAILED");
  const sent = await store.dispatchRiskHandoff(request, async () => ({ upstream_status: 202 }));
  assert.equal(sent.risk_dispatch.status, "SENT");
  assert.equal(sent.risk_dispatch.attempts, 2);
  assert.ok(sent.audit.events.some(event => event.event_type === "risk.handoff.dispatch_failed"));
  assert.ok(sent.audit.events.some(event => event.event_type === "risk.handoff.dispatched"));
});

test("Risk and approval records keep verified actor evidence", async () => {
  const store = new ReviewWorkflowStore({ modelRunner: fakeReview });
  const created = await store.start({ ...base(), capability: "SIMULATION_ONLY" });
  const risk = await store.decideRisk({ task_id: created.task_id, proposal_sha256: created.proposed_action.proposal_sha256, decision: "APPROVE", reviewer: "risk-001", reason: "通过" }, { owner: "risk", actor: "risk-001", mode: "HMAC_SHA256", verified: true, signature_header: "X-Risk-Signature" });
  assert.equal(risk.risk_decision.auth.verified, true);
  const approved = await store.decideApproval({ task_id: risk.task_id, proposal_sha256: risk.proposed_action.proposal_sha256, decision: "APPROVE", approver: "user-001", reason: "我已确认" }, { owner: "approval", actor: "user-001", mode: "HMAC_SHA256", verified: true, signature_header: "X-Approval-Signature" });
  assert.equal(approved.approval.auth.owner, "approval");
});
