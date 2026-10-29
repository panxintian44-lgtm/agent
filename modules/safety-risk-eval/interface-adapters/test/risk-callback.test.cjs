"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { buildRiskHandoffPackage, validateRiskCallback, CALLBACK_FIELDS } = require("../../../../chenchen/integrations/risk-handoff.js");
const { ADAPTER_VERSION, CallbackAdapterError, extractCoreBinding, buildRiskCallbackDraft, HANDOFF_REQUIRED_FIELDS, HANDOFF_ALLOWED_FIELDS } = require("../risk-callback.cjs");
const handoffSchema = require("../../../../chenchen/contracts/risk-handoff.v1.schema.json").$defs.HandoffPackage;

const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
test("frozen handoff field lists match the current official Core schema", () => {
  assert.ok(Object.isFrozen(HANDOFF_REQUIRED_FIELDS)); assert.ok(Object.isFrozen(HANDOFF_ALLOWED_FIELDS));
  assert.deepEqual([...HANDOFF_REQUIRED_FIELDS].sort(), [...handoffSchema.required].sort());
  assert.deepEqual([...HANDOFF_ALLOWED_FIELDS].sort(), Object.keys(handoffSchema.properties).sort());
});
function fixture(decision = "ALLOW", providerId = "provider-synthetic-001") {
  const proposal = { proposed_action: "HOLD_FOR_REVIEW", action_reason: "Synthetic read-only action", risk_level: "medium", requested_action: "Review synthetic allocation", action_parameters: { amount_yuan: "1000.00" }, model_response_id: providerId };
  const proposalHash = hash(proposal), taskId = "core-task-synthetic-001", auditId = "core-audit-synthetic-001", policy = "daily-cashflow-policy.v1.0";
  const record = { workflow_version: "review-workflow.v1", schema_version: "model-review.v1", task_id: taskId, request_id: "core-request-synthetic-001", session_id: "core-session-synthetic-001", run_id: "core-run-synthetic-001", status: "PENDING_RISK", data_mode: "SYNTHETIC_REPLAY", execution_mode: "PAPER", capability: "REVIEW_ONLY", plan_id: "core-plan-synthetic-001", plan_hash: proposalHash, policy_version: policy,
    model: { status: "PROPOSED", source: "model", model_response: { model: "synthetic-model-contract-test", call_succeeded: true, provider_response_id: providerId } }, proposed_action: { ...proposal, proposal_sha256: proposalHash },
    risk_handoff: { handoff_id: "core-handoff-synthetic-001", status: "PENDING_REVIEW", decision: "REQUIRED", owner: "Synthetic Risk Owner", evidence: { input_sha256: "a".repeat(64), model_response_id: providerId, proposal_sha256: proposalHash, audit_id: auditId, plan_id: "core-plan-synthetic-001", plan_hash: proposalHash, policy_version: policy } },
    approval: { approval_id: "approval-synthetic-001", task_id: taskId, required: true, status: "BLOCKED", decision: null, proposal_sha256: proposalHash, approver: null, decided_at: null, expires_at: null },
    audit: { audit_id: auditId, events: [] } };
  const handoff = buildRiskHandoffPackage(record), binding = extractCoreBinding(handoff);
  const reasons = decision === "ALLOW" ? [] : [{ rule_id: decision === "ERROR" ? "D01" : "D02", code: { REVIEW: "DAILY_DATA_REQUIRED", BLOCK: "PROTECTED_PURPOSE_CONFLICT", ERROR: "DAILY_CHECK_UNAVAILABLE" }[decision], message_zh: "虚构契约测试原因", status: decision }];
  return { record, input: { handoff, reviewer: "server-owned-synthetic-risk-reviewer", risk_result: { risk_check_id: "risk-check-synthetic-001", decision, check_complete: decision !== "ERROR", checked_at: "2026-10-21T12:00:00+08:00", policy_version: policy, core_binding: binding, local_task_id: "local-risk-task-synthetic-001", reasons } } };
}

for (const field of handoffSchema.required) test(`official required handoff field ${field} cannot be omitted`, () => {
  const { input } = fixture(); delete input.handoff[field];
  assert.throws(() => buildRiskCallbackDraft(input), { code: "INCOMPLETE_HANDOFF" });
});
for (const field of ["source_task_id", "approval_override", "execution", "system_permissions"]) test(`extra handoff field ${field} is rejected by the frozen boundary`, () => {
  const { input } = fixture(); input.handoff[field] = true;
  assert.throws(() => buildRiskCallbackDraft(input), { code: "UNEXPECTED_HANDOFF_FIELD" });
});

for (const [risk, core] of [["ALLOW", "APPROVE"], ["REVIEW", "REQUEST_MORE_INFO"], ["BLOCK", "REJECT"], ["ERROR", null]]) {
  test(`four-state draft: ${risk} maps to ${core || "no business callback"} without dispatch or authority`, () => {
    const f = fixture(risk), before = structuredClone(f.input), result = buildRiskCallbackDraft(f.input);
    assert.equal(result.adapter_version, ADAPTER_VERSION); assert.equal(result.risk_decision, risk);
    assert.equal(result.dispatch_allowed, false); assert.equal(result.execution_allowed, false);
    assert.deepEqual(f.input, before); assert.equal(result.status, core ? "DRAFT_READY" : "ERROR_HELD");
    assert.deepEqual(result.audit_context.reasons, f.input.risk_result.reasons);
    assert.equal(result.audit_context.local_task_id, "local-risk-task-synthetic-001");
    if (core) {
      assert.equal(result.callback.decision, core); assert.equal(result.callback.task_id, f.record.task_id);
      assert.deepEqual(Object.keys(result.callback).sort(), [...CALLBACK_FIELDS].sort());
      assert.deepEqual(validateRiskCallback(result.callback, f.record), result.callback);
      assert.ok(result.required_next_actions.includes("VERIFY_SENDER_IDENTITY_AND_APPLY_CORE_SIGNATURE_CONTRACT"));
    } else { assert.equal(result.callback, null); assert.ok(result.required_next_actions.includes("PERSIST_RISK_ERROR_AND_KEEP_EXECUTION_CLOSED")); }
  });
}

test("REVIEW recovery describes a new Core task after the immutable callback is accepted", () => {
  const result = buildRiskCallbackDraft(fixture("REVIEW").input);
  assert.ok(result.required_next_actions.includes("AFTER_ACCEPTED_REQUEST_MORE_INFO_CREATE_NEW_CORE_TASK_AND_HANDOFF"));
});

for (const field of ["handoff_id", "task_id", "request_id", "run_id", "audit_id", "proposal_sha256"]) test(`risk result cannot bind another ${field}`, () => {
  const { input } = fixture(); input.risk_result.core_binding[field] = field === "proposal_sha256" ? "b".repeat(64) : "wrong-synthetic-id";
  assert.throws(() => buildRiskCallbackDraft(input), { name: "CallbackAdapterError", code: "RISK_HANDOFF_MISMATCH", execution_allowed: false });
});

for (const field of ["handoff_id", "task_id", "request_id", "run_id", "audit_id"]) test(`trace must agree on ${field}`, () => {
  const { input } = fixture(); input.handoff.trace[field] = "another-synthetic-id";
  assert.throws(() => buildRiskCallbackDraft(input), { code: "RISK_HANDOFF_MISMATCH" });
});

test("the official trace has no proposal digest, while nullable session and provider receipts remain nullable", () => {
  const { input } = fixture("ALLOW", null); input.handoff.session_id = null; input.handoff.trace.session_id = null;
  assert.equal(Object.hasOwn(input.handoff.trace, "proposal_sha256"), false);
  const result = buildRiskCallbackDraft(input); assert.equal(result.callback.decision, "APPROVE");
  assert.equal(input.handoff.model.provider_response_id, null); assert.equal(input.handoff.evidence.model_response_id, null);
});

test("full proposal content includes action parameters and optional funding in the original insertion order", () => {
  const { input } = fixture();
  input.handoff.proposal.action_parameters.amount_yuan = "9999.00";
  assert.throws(() => buildRiskCallbackDraft(input), { code: "PROPOSAL_CONTENT_CHANGED" });
  const second = fixture().input; second.handoff.proposal.funding = { plan_id: "synthetic-funding-plan", amount_minor: 100000 };
  assert.throws(() => buildRiskCallbackDraft(second), { code: "PROPOSAL_CONTENT_CHANGED" });
});

test("reordered proposal keys are rejected rather than assigned a new canonical digest", () => {
  const { input } = fixture(), oldHash = input.handoff.proposal.proposal_sha256;
  input.handoff.proposal = Object.fromEntries(Object.entries(input.handoff.proposal).reverse());
  assert.throws(() => buildRiskCallbackDraft(input), { code: "PROPOSAL_CONTENT_CHANGED" });
  assert.equal(input.handoff.proposal.proposal_sha256, oldHash);
});

for (const [label, mutate] of [
  ["proposal digest", i => { i.handoff.proposal.proposal_sha256 = "not-sha"; }],
  ["evidence digest", i => { i.handoff.evidence.proposal_sha256 = "b".repeat(64); }],
  ["plan digest", i => { i.handoff.plan_hash = "b".repeat(64); }],
  ["evidence plan digest", i => { i.handoff.evidence.plan_hash = "b".repeat(64); }],
  ["approval digest", i => { i.handoff.approval.proposal_sha256 = "b".repeat(64); }],
  ["evidence audit", i => { i.handoff.evidence.audit_id = "another-audit"; }],
  ["audit summary", i => { i.handoff.audit.audit_id = "another-audit"; }],
  ["provider receipt", i => { i.handoff.evidence.model_response_id = "invented-provider-id"; }],
  ["policy version", i => { i.risk_result.policy_version = "another-policy"; }],
  ["trace session", i => { i.handoff.trace.session_id = "another-session"; }]
]) test(`changed ${label} fails closed`, () => { const { input } = fixture(); mutate(input); assert.throws(() => buildRiskCallbackDraft(input), CallbackAdapterError); });

for (const [label, mutate] of [
  ["handoff version", i => { i.handoff.handoff_version = "risk-handoff.v2"; }],
  ["Core contract", i => { i.handoff.contract_version = "model-review.v2"; }],
  ["callback fields", i => { i.handoff.callback.required_fields.push("approval"); }],
  ["callback endpoint", i => { i.handoff.callback.endpoint = "https://attacker.example/approve"; }],
  ["real execution mode", i => { i.handoff.execution_mode = "LIVE"; }],
  ["execution already allowed", i => { i.handoff.execution_allowed = true; }],
  ["wrong phase", i => { i.handoff.workflow_status = "READY_FOR_SIMULATION"; }],
  ["rules fallback", i => { i.handoff.model.source = "rules"; }],
  ["failed model", i => { i.handoff.model.call_succeeded = false; }],
  ["authority claim", i => { i.handoff.input_authority = "SYSTEM"; }],
  ["preapproved", i => { i.handoff.approval.status = "APPROVED"; }],
  ["forged approver", i => { i.handoff.approval.approver = "already-approved"; }]
]) test(`${label} cannot produce a callback draft`, () => { const { input } = fixture(); mutate(input); assert.throws(() => buildRiskCallbackDraft(input), CallbackAdapterError); });

for (const [label, mutate] of [
  ["unknown risk state", i => { i.risk_result.decision = "APPROVE"; }],
  ["incomplete ALLOW", i => { i.risk_result.check_complete = false; }],
  ["ERROR labelled complete", i => { i.risk_result.decision = "ERROR"; }],
  ["known BLOCK hidden by ALLOW", i => { i.risk_result.reasons = [{ rule_id: "D02", code: "PROTECTED_PURPOSE_CONFLICT", message_zh: "虚构冲突", status: "BLOCK" }]; }],
  ["missing REVIEW reason", i => { i.risk_result.decision = "REVIEW"; }],
  ["unregistered reason status", i => { i.risk_result.reasons = [{ rule_id: "D02", code: "WARNING_ONLY", message_zh: "虚构提醒", status: "WARNING" }]; }],
  ["fake check date", i => { i.risk_result.checked_at = "2026-02-30T12:00:00Z"; }],
  ["missing check id", i => { delete i.risk_result.risk_check_id; }],
  ["client execution field", i => { i.risk_result.execution_allowed = true; }],
  ["client approval field", i => { i.approval = { status: "CONFIRMED" }; }],
  ["client risk binding field", i => { i.risk_result.core_binding.user_id = "admin"; }],
  ["reason authority field", i => { i.risk_result.reasons = [{ rule_id: "D02", code: "PROTECTED_PURPOSE_CONFLICT", message_zh: "虚构冲突", status: "BLOCK", approval: true }]; }],
  ["array reason code", i => { i.risk_result.reasons = [{ rule_id: "D02", code: ["PROTECTED_PURPOSE_CONFLICT"], message_zh: "虚构冲突", status: "BLOCK" }]; }]
]) test(`${label} is rejected before mapping`, () => { const { input } = fixture(); mutate(input); assert.throws(() => buildRiskCallbackDraft(input), CallbackAdapterError); });

test("ERROR remains dominant when a known hard conflict also exists", () => {
  const { input } = fixture("ERROR"); input.risk_result.reasons.push({ rule_id: "D02", code: "PROTECTED_PURPOSE_CONFLICT", message_zh: "虚构硬冲突", status: "BLOCK" });
  const result = buildRiskCallbackDraft(input); assert.equal(result.risk_decision, "ERROR"); assert.equal(result.callback, null); assert.equal(result.audit_context.reasons.length, 2);
});

test("callback reasons exceeding Core's 500-character limit are rejected, never truncated", () => {
  const { input } = fixture("BLOCK"); input.risk_result.risk_check_id = "r".repeat(490);
  assert.throws(() => buildRiskCallbackDraft(input), { code: "CALLBACK_REASON_TOO_LONG" });
});

test("risk approval draft does not invent a mandatory human approval for Core NOT_REQUIRED", () => {
  const { input } = fixture(); input.handoff.approval.required = false; input.handoff.approval.status = "NOT_REQUIRED";
  const output = buildRiskCallbackDraft(input); assert.equal(output.dispatch_allowed, false); assert.equal(output.execution_allowed, false);
  assert.ok(output.required_next_actions.includes("APPLY_CORE_APPROVAL_AND_EXECUTION_GATES")); assert.equal(input.handoff.approval.required, false);
});
