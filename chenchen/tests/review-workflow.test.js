"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { ReviewWorkflowStore, WorkflowError, fingerprint } = require("../integrations/review-workflow");

function fakeReview(input) {
  return Promise.resolve({
    review_version: "model-review.v1",
    run_id: "review-fake-001",
    request_id: input.request_id,
    task_id: input.task_id,
    status: "PROPOSED",
    source: "model",
    input: { kind: input.kind || "bill", source: input.source || "test", input_sha256: "a".repeat(64) },
    model_response: {
      model: "fake-model",
      provider_response_id: "resp-fake-001",
      raw_text: JSON.stringify({
        summary: "账单需要人工复核",
        risk_level: "medium",
        proposed_action: "HOLD_FOR_REVIEW",
        action_reason: "外部账单不能直接触发付款",
        missing_information: ["付款状态"],
        evidence: ["金额", "到期日"]
      }),
      proposal: {
        summary: "账单需要人工复核",
        risk_level: "medium",
        proposed_action: "HOLD_FOR_REVIEW",
        action_reason: "外部账单不能直接触发付款",
        missing_information: ["付款状态"],
        evidence: ["金额", "到期日"]
      },
      usage: { input_tokens: 10, output_tokens: 10 }
    },
    audit: { audit_id: "audit-fake-001", events: [{ event_type: "review.received", at: new Date().toISOString() }] }
  });
}

test("golden path keeps one task across model, Risk, approval, simulation and audit", async () => {
  const store = new ReviewWorkflowStore({ modelRunner: fakeReview });
  const created = await store.start({ capability: "SIMULATION_ONLY", request_id: "req-golden-001", kind: "bill", text: "演示账单", action_parameters: { amount: 1280 } });
  assert.equal(created.status, "PENDING_RISK");
  assert.equal(created.risk_handoff.execution_allowed, false);
  assert.equal(created.execution.status, "BLOCKED");
  assert.equal(created.audit.task_id, created.task_id);
  await assert.rejects(store.simulate({ task_id: created.task_id, proposal_sha256: created.proposed_action.proposal_sha256 }), error => {
    assert.equal(error.code, "EXECUTION_BLOCKED");
    assert.equal(error.record.task_id, created.task_id);
    return true;
  });

  const risk = await store.decideRisk({ task_id: created.task_id, proposal_sha256: created.proposed_action.proposal_sha256, decision: "APPROVE", reviewer: "risk-owner", reason: "证据足够，进入人工审批" });
  assert.equal(risk.status, "PENDING_APPROVAL");
  assert.equal(risk.risk_decision.status, "APPROVED");
  await assert.rejects(store.simulate({ task_id: created.task_id, proposal_sha256: created.proposed_action.proposal_sha256 }), error => error.code === "EXECUTION_BLOCKED");

  const approval = await store.decideApproval({ task_id: created.task_id, proposal_sha256: created.proposed_action.proposal_sha256, decision: "APPROVE", approver: "approver-1", reason: "人工确认" });
  assert.equal(approval.status, "READY_FOR_SIMULATION");
  assert.equal(approval.approval.status, "APPROVED");
  const simulated = await store.simulate({ task_id: created.task_id, proposal_sha256: created.proposed_action.proposal_sha256 });
  assert.equal(simulated.status, "SIMULATED");
  assert.equal(simulated.execution.receipt.side_effects, false);
  assert.equal(simulated.execution.execution_allowed, false);
  assert.equal(simulated.task_id, created.task_id);
  assert.equal(simulated.run_id, created.run_id);
  assert.equal(simulated.audit.audit_id, created.audit.audit_id);
  assert.ok(simulated.audit.events.some(item => item.event_type === "execution.simulated"));
});

test("Risk rejection remains terminal for execution", async () => {
  const store = new ReviewWorkflowStore({ modelRunner: fakeReview });
  const created = await store.start({ capability: "SIMULATION_ONLY", kind: "bill", text: "演示账单" });
  const rejected = await store.decideRisk({ task_id: created.task_id, proposal_sha256: created.proposed_action.proposal_sha256, decision: "REJECT", reviewer: "risk-owner", reason: "用途冲突，拒绝进入执行" });
  assert.equal(rejected.status, "REJECTED");
  assert.equal(rejected.execution.simulation_allowed, false);
  await assert.rejects(store.simulate({ task_id: created.task_id, proposal_sha256: created.proposed_action.proposal_sha256 }), error => {
    assert.equal(error.code, "EXECUTION_BLOCKED");
    assert.equal(error.record.status, "REJECTED");
    return true;
  });
  assert.ok(store.getByTaskId(created.task_id).audit.events.some(item => item.event_type === "execution.blocked"));
});

test("proposal hash prevents approval after parameters change", async () => {
  const store = new ReviewWorkflowStore({ modelRunner: fakeReview });
  const created = await store.start({ capability: "SIMULATION_ONLY", kind: "bill", text: "演示账单" });
  await assert.rejects(store.decideRisk({ task_id: created.task_id, proposal_sha256: "changed", decision: "APPROVE", reviewer: "risk-owner", reason: "测试" }), error => error instanceof WorkflowError && error.code === "PROPOSAL_CHANGED");
});

test("model failure creates an auditable blocked workflow", async () => {
  const store = new ReviewWorkflowStore({ modelRunner: async () => { const error = new Error("provider unavailable"); error.code = "MODEL_PROVIDER_UNAVAILABLE"; error.retryable = true; throw error; } });
  await assert.rejects(store.start({ capability: "SIMULATION_ONLY", request_id: "req-failed-001", kind: "news", text: "演示新闻" }), error => {
    assert.equal(error.workflowRecord.status, "MODEL_FAILED");
    assert.equal(error.workflowRecord.risk_handoff.execution_allowed, false);
    assert.ok(error.workflowRecord.audit.events.some(item => item.event_type === "model.failed"));
    return true;
  });
});

test("legacy default-only retries reuse their original record and changed inputs still conflict", async () => {
  let calls = 0;
  const store = new ReviewWorkflowStore({ modelRunner: input => { calls++; return fakeReview(input); } });
  const input = { text: "虚构旧版账单", idempotency_key: "legacy-retry", action_parameters: { amount: 25 } };
  const created = await store.start(input);
  const legacy = structuredClone(created);
  delete legacy.reviewed_input.scenario;
  delete legacy.reviewed_input.output_formats;
  legacy.request_fingerprint = await fingerprint(legacy.reviewed_input);
  store.records.set(legacy.run_id, legacy);
  const replay = await store.start(input);
  assert.deepEqual(replay, legacy);
  assert.equal(calls, 1);
  for (const changed of [{ text: "不同用途" }, { action_parameters: { amount: 26 } },
    { scenario: "SUBSCRIPTION_REVIEW" }, { output_formats: ["json", "xlsx"] }]) {
    await assert.rejects(store.start({ capability: "SIMULATION_ONLY", ...input, ...changed }), error => error.code === "IDEMPOTENCY_CONFLICT");
  }
  assert.equal(calls, 1);
});

test("terminal workflow states cannot be mutated by repeated Risk or approval calls", async () => {
  const store = new ReviewWorkflowStore({ modelRunner: fakeReview });
  const created = await store.start({ capability: "SIMULATION_ONLY", kind: "bill", text: "演示账单" });
  const base = { task_id: created.task_id, proposal_sha256: created.proposed_action.proposal_sha256 };
  await store.decideRisk({ ...base, decision: "APPROVE", reviewer: "risk-owner", reason: "通过" });
  await store.decideApproval({ ...base, decision: "APPROVE", approver: "approver", reason: "通过" });
  const simulated = await store.simulate(base);
  assert.equal(simulated.status, "SIMULATED");
  await assert.rejects(store.decideRisk({ ...base, decision: "APPROVE", reviewer: "risk-owner", reason: "重复提交" }), error => error.code === "WORKFLOW_TERMINAL");
  await assert.rejects(store.decideApproval({ ...base, decision: "APPROVE", approver: "approver", reason: "重复提交" }), error => error.code === "WORKFLOW_TERMINAL");
  const current = store.getByTaskId(created.task_id);
  assert.equal(current.status, "SIMULATED");
  assert.equal(current.execution.status, "SIMULATED");
  assert.equal(current.execution.execution_allowed, false);
});
