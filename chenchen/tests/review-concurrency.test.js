"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { ReviewWorkflowStore } = require("../integrations/review-workflow");

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function model(input) {
  return { run_id: "synthetic-run-" + input.task_id, status: "PROPOSED", source: "model",
    input: { input_sha256: "a".repeat(64), kind: input.kind },
    model_response: { call_succeeded: true, provider_response_id: "synthetic-response", model: "synthetic",
      proposal: { summary: "Synthetic review", risk_level: "unknown", proposed_action: "HOLD_FOR_REVIEW",
        action_reason: "Wait for Risk", missing_information: [], evidence: [] } },
    audit: { audit_id: "audit-" + input.task_id, events: [] } };
}
async function setup() {
  const store = new ReviewWorkflowStore({ modelRunner: async input => model(input) });
  const task = await store.start({ capability: "SIMULATION_ONLY", text: "虚构房租与投资安排", data_mode: "SYNTHETIC_REPLAY" });
  const input = { task_id: task.task_id, proposal_sha256: task.proposed_action.proposal_sha256 };
  const callback = decision => ({ ...input, callback_version: "risk-callback.v1", request_id: task.request_id,
    run_id: task.run_id, handoff_id: task.risk_handoff.handoff_id, audit_id: task.audit.audit_id,
    decision, reviewer: "synthetic-risk", reason: "Synthetic callback" });
  return { store, task, input, callback };
}

test("late dispatch success preserves cancellation and every audit event", async () => {
  const { store, task, input } = await setup(); const gate = deferred();
  const pending = store.dispatchRiskHandoff(input, () => gate.promise);
  await store.cancel({ ...input, canceler: "synthetic-user", reason: "Changed my plan" });
  gate.resolve({ upstream_status: 202 });
  const result = await pending;
  assert.equal(result.status, "CANCELLED");
  assert.equal(result.risk_dispatch.status, "SENT");
  assert.equal(result.execution.simulation_allowed, false);
  const events = store.getByTaskId(task.task_id).audit.events.map(x => x.event_type);
  assert.ok(events.includes("task.cancelled"));
  assert.ok(events.includes("risk.handoff.dispatched"));
  await assert.rejects(store.simulate(input), e => e.code === "EXECUTION_BLOCKED");
});

test("late dispatch failure preserves a previously received Risk rejection", async () => {
  const { store, task, input, callback } = await setup(); const gate = deferred();
  const pending = store.dispatchRiskHandoff(input, () => gate.promise);
  await store.receiveRiskCallback(callback("REJECT"));
  gate.reject(Object.assign(new Error("Synthetic outage"), { code: "OWNER_SERVICE_UNAVAILABLE" }));
  await assert.rejects(pending, e => e.code === "OWNER_SERVICE_UNAVAILABLE" && e.workflowRecord.status === "REJECTED");
  const result = store.getByTaskId(task.task_id);
  assert.equal(result.risk_decision.decision, "REJECT");
  assert.equal(result.risk_callback.request.decision, "REJECT");
  assert.ok(result.audit.events.some(x => x.event_type === "risk.callback.recorded"));
  await assert.rejects(store.simulate(input), e => e.code === "EXECUTION_BLOCKED");
});

test("dispatch completion cannot roll back callback, approval or a simulation receipt", async () => {
  const { store, input, callback } = await setup(); const gate = deferred();
  const pending = store.dispatchRiskHandoff(input, () => gate.promise);
  await store.receiveRiskCallback(callback("APPROVE"));
  await store.decideApproval({ ...input, decision: "APPROVE", approver: "synthetic-user", reason: "PAPER only" });
  const executed = await store.simulate(input);
  gate.resolve({ upstream_status: 202 });
  const result = await pending;
  assert.equal(result.status, "SIMULATED");
  assert.deepEqual(result.execution.receipt, executed.execution.receipt);
  assert.equal(result.audit.events.filter(x => x.event_type === "execution.simulated").length, 1);
});

test("simultaneous dispatch requests send once and validate bindings", async () => {
  const { store, input } = await setup(); const gate = deferred(); let sends = 0;
  const sender = () => { sends++; return gate.promise; };
  const first = store.dispatchRiskHandoff(input, sender);
  const second = store.dispatchRiskHandoff(input, sender);
  await assert.rejects(store.dispatchRiskHandoff({ ...input, proposal_sha256: "wrong" }, sender), e => e.code === "PROPOSAL_CHANGED");
  assert.equal(sends, 1);
  gate.resolve({ upstream_status: 202 });
  const both = await Promise.all([first, second]);
  assert.equal(both[0].risk_dispatch.dispatch_id, both[1].risk_dispatch.dispatch_id);
  assert.equal(both[0].risk_dispatch.attempts, 1);
  assert.equal(both[0].audit.events.filter(x => x.event_type === "risk.handoff.dispatched").length, 1);
});

test("same idempotency key during a slow model request creates only one call and task", async () => {
  const gate = deferred(); let calls = 0;
  const store = new ReviewWorkflowStore({ modelRunner: async input => { calls++; await gate.promise; return model(input); } });
  const input = { text: "虚构账单", idempotency_key: "inflight-idempotency", data_mode: "FIXTURE" };
  const first = store.start(input); const second = store.start(input);
  assert.equal(calls, 1);
  gate.resolve();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.task_id, b.task_id);
  assert.equal(a.run_id, b.run_id);
  assert.equal(store.records.size, 1);
});

test("changed inputs sharing an in-flight idempotency key cannot trigger a second model call", async () => {
  const gate = deferred(); let calls = 0;
  const store = new ReviewWorkflowStore({ modelRunner: async input => { calls++; await gate.promise; return model(input); } });
  const first = store.start({ text: "虚构账单100元", idempotency_key: "same-key" });
  const changed = store.start({ text: "虚构账单1000元", idempotency_key: "same-key" });
  const rejected = assert.rejects(changed, e => e.code === "IDEMPOTENCY_CONFLICT");
  gate.resolve();
  await Promise.all([first, rejected]);
  assert.equal(calls, 1);
});

test("failed concurrent model requests keep one auditable failure and release the lock", async () => {
  const gate = deferred(); let calls = 0;
  const store = new ReviewWorkflowStore({ modelRunner: async () => { calls++; await gate.promise; throw Object.assign(new Error("Synthetic failure"), { code: "MODEL_PROVIDER_ERROR" }); } });
  const input = { text: "虚构账单", idempotency_key: "failed-key" };
  const first = store.start(input); const second = store.start(input);
  const results = Promise.allSettled([first, second]); gate.resolve(); await results;
  assert.equal(calls, 1);
  assert.equal(store.records.size, 1);
  const record = await store.start(input);
  assert.equal(record.status, "MODEL_FAILED");
  assert.equal(record.execution.status, "BLOCKED");
});
