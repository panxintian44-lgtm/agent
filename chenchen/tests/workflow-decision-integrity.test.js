"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { ReviewWorkflowStore } = require("../integrations/review-workflow");

async function fixture() {
  const store = new ReviewWorkflowStore();
  const record = await store.start({ capability: "SIMULATION_ONLY", kind: "bill", text: "虚构投资计划与房租用途检查", context: { synthetic: true } }, {
    MODEL_PROVIDER: "workers_ai", MODEL_DISABLE_RULE_FALLBACK: "true",
    AI: { run: async () => ({ id: "synthetic-decision-test", response: {
      summary: "虚构资金用途需复核", risk_level: "medium", proposed_action: "HOLD_FOR_REVIEW",
      action_reason: "先经过Risk与审批", missing_information: [], evidence: ["虚构用途"]
    } }) }
  });
  const base = { task_id: record.task_id, proposal_sha256: record.proposed_action.proposal_sha256 };
  const callback = { ...base, callback_version: "risk-callback.v1", handoff_id: record.risk_handoff.handoff_id,
    request_id: record.request_id, run_id: record.run_id, audit_id: record.audit.audit_id,
    decision: "APPROVE", reviewer: "synthetic-risk", reason: "已核对虚构证据" };
  return { store, record, base, callback };
}

test("a callback racing cancellation must not restore the cancelled task", async () => {
  const { store, record, base, callback } = await fixture();
  const [risk, cancelled] = await Promise.all([
    store.receiveRiskCallback(callback),
    store.cancel({ ...base, canceler: "synthetic-user", reason: "停止任务" })
  ]);
  assert.equal(risk.callback_status, "RECORDED");
  assert.equal(cancelled.status, "CANCELLED");
  const final = store.getByTaskId(record.task_id);
  assert.equal(final.status, "CANCELLED");
  assert.equal(final.approval.status, "BLOCKED");
  assert.equal(final.execution.simulation_allowed, false);
  assert.ok(final.audit.events.some(e => e.event_type === "risk.callback.recorded"));
  assert.ok(final.audit.events.some(e => e.event_type === "task.cancelled"));
  const repeated = await store.receiveRiskCallback(callback);
  assert.equal(repeated.callback_status, "DUPLICATE");
  assert.deepEqual(repeated.workflow, final);
  await assert.rejects(store.simulate(base), e => e.code === "EXECUTION_BLOCKED");
});

test("simultaneous identical callbacks record exactly once in the shared workflow", async () => {
  const { store, record, callback } = await fixture();
  const results = await Promise.all([store.receiveRiskCallback(callback), store.receiveRiskCallback(callback)]);
  assert.deepEqual(results.map(r => r.callback_status), ["RECORDED", "DUPLICATE"]);
  assert.deepEqual(results[0].workflow, results[1].workflow);
  assert.equal(store.getByTaskId(record.task_id).audit.events.filter(e => e.event_type === "risk.callback.recorded").length, 1);
});

test("Risk retries require the same normalized reviewer, decision and reason", async () => {
  const { store, record, base } = await fixture();
  const request = { ...base, decision: "APPROVE", reviewer: "synthetic-risk", reason: "已核对" };
  const first = await store.decideRisk(request);
  assert.deepEqual(await store.decideRisk({ ...request, reviewer: " synthetic-risk ", reason: " 已核对 " }), first);
  for (const patch of [{ reviewer: "someone-else" }, { reason: "另一种依据" }, { decision: "REJECT" }]) {
    await assert.rejects(store.decideRisk({ ...request, ...patch }), e => e.code === "RISK_DECISION_IMMUTABLE");
  }
  const current = store.getByTaskId(record.task_id);
  assert.deepEqual(current.risk_decision, first.risk_decision);
  assert.equal(current.audit.events.filter(e => e.event_type === "workflow.operation_blocked").length, 3);
});

test("approval retries cannot silently substitute a different person or reason", async () => {
  const { store, record, base, callback } = await fixture();
  await store.receiveRiskCallback(callback);
  const request = { ...base, decision: "APPROVE", approver: "synthetic-user", reason: "只同意这次模拟" };
  const first = await store.decideApproval(request);
  assert.deepEqual(await store.decideApproval(request), first);
  for (const patch of [{ approver: "someone-else" }, { reason: "更换依据" }, { decision: "REJECT" }]) {
    await assert.rejects(store.decideApproval({ ...request, ...patch }), e => e.code === "APPROVAL_IMMUTABLE");
  }
  const current = store.getByTaskId(record.task_id);
  assert.deepEqual(current.approval, first.approval);
  assert.equal(current.execution.execution_allowed, false);
});

test("missing or overlong reasons cannot be hidden by duplicate decisions", async () => {
  const { store, base, callback } = await fixture();
  await store.receiveRiskCallback(callback);
  const approval = { ...base, decision: "APPROVE", approver: "synthetic-user", reason: "核对" };
  await store.decideApproval(approval);
  for (const reason of [undefined, " ", "x".repeat(501)]) {
    await assert.rejects(store.decideRisk({ ...base, decision: "APPROVE", reviewer: callback.reviewer, reason }), e => e.code === "INVALID_WORKFLOW_INPUT");
    await assert.rejects(store.decideApproval({ ...approval, reason }), e => e.code === "INVALID_WORKFLOW_INPUT");
  }
  const record = store.getByTaskId(base.task_id);
  assert.equal(record.audit.events.filter(e => e.event_type === "workflow.operation_blocked" && e.payload.code === "INVALID_WORKFLOW_INPUT").length, 6);
});

test("a cancellation accepted first rejects late Risk callbacks and keeps its audit", async () => {
  const { store, base, callback } = await fixture();
  const results = await Promise.allSettled([
    store.cancel({ ...base, canceler: "synthetic-user", reason: "先取消" }), store.receiveRiskCallback(callback)
  ]);
  assert.equal(results[0].status, "fulfilled");
  assert.equal(results[1].status, "rejected");
  assert.equal(results[1].reason.code, "WORKFLOW_TERMINAL");
  const final = store.getByTaskId(base.task_id);
  assert.equal(final.status, "CANCELLED");
  assert.equal(final.risk_decision, null);
  assert.ok(final.audit.events.some(e => e.event_type === "task.cancelled"));
  assert.ok(final.audit.events.some(e => e.payload.code === "WORKFLOW_TERMINAL"));
});

test("competing callbacks cannot replace the accepted evidence or lose the blocked event", async () => {
  const { store, base, callback } = await fixture();
  const results = await Promise.allSettled([
    store.receiveRiskCallback(callback), store.receiveRiskCallback({ ...callback, reviewer: "someone-else" })
  ]);
  assert.equal(results[0].status, "fulfilled");
  assert.equal(results[1].reason.code, "RISK_CALLBACK_CONFLICT");
  const final = store.getByTaskId(base.task_id);
  assert.equal(final.risk_decision.reviewer, callback.reviewer);
  assert.equal(final.audit.events.filter(e => e.event_type === "risk.callback.recorded").length, 1);
  assert.ok(final.audit.events.some(e => e.payload.code === "RISK_CALLBACK_CONFLICT"));
});

test("decision labels accept 500 characters but never truncate overlong identities", async () => {
  const { store, base } = await fixture();
  for (const field of ["reviewer", "reason"]) {
    await assert.rejects(store.decideRisk({ ...base, decision: "APPROVE", reviewer: "risk", reason: "reason", [field]: "x".repeat(501) }), e => e.statusCode === 422);
  }
  assert.equal(store.getByTaskId(base.task_id).risk_decision, null);
  const valid = await store.decideRisk({ ...base, decision: "APPROVE", reviewer: "x".repeat(500), reason: "r".repeat(500) });
  assert.equal(valid.risk_decision.reviewer.length, 500);
  assert.equal(valid.risk_decision.reason.length, 500);
});
