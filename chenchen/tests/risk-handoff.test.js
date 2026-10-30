"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { randomUUID } = require("node:crypto");
const { ReviewWorkflowStore } = require("../integrations/review-workflow");
const { buildRiskHandoffPackage, validateRiskCallback } = require("../integrations/risk-handoff");

function setup() {
  return new ReviewWorkflowStore({ modelRunner: async input => ({
    run_id: "review-" + randomUUID(), status: "PROPOSED", source: "model",
    input: { kind: input.kind, input_sha256: "a".repeat(64) },
    model_response: { call_succeeded: true, model: "test-double", provider_response_id: "synthetic-response", proposal: {
      proposed_action: "HOLD_FOR_REVIEW", action_reason: "Check the rent reserve", risk_level: "high"
    } },
    audit: { audit_id: "audit-" + randomUUID(), events: [] }
  }) });
}
function callbackFor(record, decision = "APPROVE") {
  return {
    callback_version: "risk-callback.v1", handoff_id: record.risk_handoff.handoff_id,
    task_id: record.task_id, request_id: record.request_id, run_id: record.run_id,
    audit_id: record.audit.audit_id, proposal_sha256: record.proposed_action.proposal_sha256,
    decision, reviewer: "synthetic-risk-owner", reason: "Synthetic integration test"
  };
}
const input = { capability: "SIMULATION_ONLY", kind: "bill", text: "Synthetic rent obligation", action_parameters: { amount: 8000, currency: "CNY" } };

test("handoff is a detached export with trace identifiers and model evidence", async () => {
  const store = setup();
  const record = await store.start(input);
  const handoff = buildRiskHandoffPackage(record);
  assert.equal(handoff.handoff_version, "risk-handoff.v1");
  assert.equal(handoff.audit_id, record.audit.audit_id);
  assert.equal(handoff.request_id, record.request_id);
  assert.equal(handoff.evidence.proposal_sha256, record.proposed_action.proposal_sha256);
  assert.equal(Object.hasOwn(handoff, "source_task_id"), false);
  assert.equal(handoff.model.call_succeeded, true);
  // Records made before retry instrumentation must not invent a historical count.
  assert.equal("attempt_count" in handoff.model, false);
  assert.equal("retry_count" in handoff.model, false);
  assert.equal(handoff.execution_allowed, false);
  assert.equal(handoff.reviewed_input.text, input.text);
  assert.equal(handoff.input_authority, "UNVERIFIED_CALLER_INPUT");
  handoff.reviewed_input.text = "Injected replacement";
  assert.equal(record.reviewed_input.text, input.text);
  handoff.proposal.action_parameters.amount = 1;
  assert.equal(record.proposed_action.action_parameters.amount, 8000);
  assert.deepEqual(validateRiskCallback(callbackFor(record), record), callbackFor(record));
});

test("every identity mismatch is rejected and recorded without allowing execution", async () => {
  const store = setup();
  const record = await store.start(input);
  for (const field of ["handoff_id", "request_id", "run_id", "audit_id", "proposal_sha256"]) {
    await assert.rejects(store.receiveRiskCallback({ ...callbackFor(record), [field]: "wrong" }), e => e.code === "RISK_HANDOFF_MISMATCH");
  }
  const other = await store.start(input);
  await assert.rejects(store.receiveRiskCallback({ ...callbackFor(record), task_id: other.task_id }), e => e.code === "RISK_HANDOFF_MISMATCH");
  const current = store.getByTaskId(record.task_id);
  assert.equal(current.status, "PENDING_RISK");
  assert.equal(current.risk_decision, null);
  assert.equal(current.audit.events.filter(e => e.event_type === "risk.callback.blocked").length, 5);
  assert.equal(current.execution.execution_allowed, false);
  await assert.rejects(store.simulate({ task_id: record.task_id, proposal_sha256: record.proposed_action.proposal_sha256 }), e => e.code === "EXECUTION_BLOCKED");
});

test("callback rejects unsupported fields, versions, decisions, and incomplete evidence", async () => {
  const store = setup();
  const record = await store.start(input);
  for (const patch of [
    { action_parameters: { amount: 1 } }, { execution_allowed: true },
    { callback_version: "risk-callback.v2" }, { decision: "EXECUTE" },
    { reviewer: " " }, { reason: "x".repeat(501) }, { audit_id: undefined }
  ]) {
    await assert.rejects(store.receiveRiskCallback({ ...callbackFor(record), ...patch }), e => e.code === "INVALID_RISK_CALLBACK");
  }
  assert.equal(store.getByTaskId(record.task_id).risk_decision, null);
});

test("callback approval still requires human approval; duplicate after simulation has no side effects", async () => {
  const store = setup();
  const record = await store.start(input);
  const callback = callbackFor(record);
  const recorded = await store.receiveRiskCallback(callback);
  assert.equal(recorded.callback_status, "RECORDED");
  assert.equal(recorded.workflow.status, "PENDING_APPROVAL");
  const base = { task_id: record.task_id, proposal_sha256: record.proposed_action.proposal_sha256 };
  await assert.rejects(store.simulate(base), e => e.code === "EXECUTION_BLOCKED");
  await store.decideApproval({ ...base, decision: "APPROVE", approver: "synthetic-user", reason: "Test approval" });
  const simulated = await store.simulate(base);
  const duplicate = await store.receiveRiskCallback(callback);
  assert.equal(duplicate.callback_status, "DUPLICATE");
  assert.deepEqual(duplicate.workflow, simulated);
  assert.equal(simulated.execution.receipt.side_effects, false);
  await assert.rejects(store.receiveRiskCallback({ ...callback, decision: "REJECT" }), e => e.code === "RISK_CALLBACK_CONFLICT");
  assert.equal(store.getByTaskId(record.task_id).status, "SIMULATED");
});

test("rejected and more-info callbacks remain blocked and accept only identical retries", async () => {
  for (const decision of ["REJECT", "REQUEST_MORE_INFO"]) {
    const store = setup();
    const record = await store.start(input);
    const callback = callbackFor(record, decision);
    const result = await store.receiveRiskCallback(callback);
    assert.equal(result.workflow.status, decision === "REJECT" ? "REJECTED" : "PENDING_RISK");
    assert.deepEqual((await store.receiveRiskCallback(callback)).workflow, result.workflow);
    await assert.rejects(store.receiveRiskCallback({ ...callback, reviewer: "someone-else" }), e => e.code === "RISK_CALLBACK_CONFLICT");
    await assert.rejects(store.simulate({ task_id: record.task_id, proposal_sha256: record.proposed_action.proposal_sha256 }), e => e.code === "EXECUTION_BLOCKED");
  }
});

test("callback cannot adopt or replace a decision recorded through the old endpoint", async () => {
  const store = setup();
  const record = await store.start(input);
  const { task_id, proposal_sha256, decision, reviewer, reason } = callbackFor(record);
  await store.decideRisk({ task_id, proposal_sha256, decision, reviewer, reason });
  await assert.rejects(store.receiveRiskCallback(callbackFor(record)), e => e.code === "RISK_DECISION_IMMUTABLE");
  assert.equal(store.getByTaskId(record.task_id).risk_callback, undefined);
});
