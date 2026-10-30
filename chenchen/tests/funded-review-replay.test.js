"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { ReviewWorkflowStore } = require("../integrations/review-workflow");
const { FundingPlanStore } = require("../integrations/funding-plan");

function fixture(fail = false) {
  const plans = new FundingPlanStore(), calls = [];
  const definition = { synthetic: true, confirmed: true, currency: "CNY", cash_minor: 1000000,
    protected_purposes: [{ purpose_id: "rent", label: "Synthetic rent", amount_minor: 400000 }] };
  const plan = plans.create(definition);
  const request = { capability: "SIMULATION_ONLY", text: "合成投资，先保留房租", idempotency_key: "funded-replay", data_mode: "SYNTHETIC_REPLAY",
    context: { user_note: "保留原话" }, action_parameters: { synthetic: true, currency: "CNY", amount: 3000,
      funding_plan_id: plan.plan_id, funding_plan_revision: plan.revision } };
  const store = new ReviewWorkflowStore({ fundingPlans: plans, modelRunner: async input => {
    calls.push(structuredClone(input));
    if (fail) throw Object.assign(new Error("Synthetic model failure"), { code: "MODEL_PROVIDER_ERROR" });
    return { run_id: "synthetic-run-" + input.task_id, source: "model", status: "PROPOSED", input: { input_sha256: "a".repeat(64) },
      model_response: { provider_response_id: "synthetic-response", proposal: {
        proposed_action: "HOLD_FOR_REVIEW", risk_level: "unknown", action_reason: "Wait for Risk" } },
      audit: { audit_id: "synthetic-audit-" + input.task_id, events: [] } };
  } });
  return { store, plans, plan, request, calls, definition };
}

for (const fail of [false, true]) test("funded request replay preserves one " + (fail ? "model failure" : "proposal") + " and rejects real input changes", async () => {
  const { store, request, calls } = fixture(fail), original = structuredClone(request);
  if (fail) await assert.rejects(store.start(request), { code: "MODEL_PROVIDER_ERROR" });
  else await store.start(request);
  const existing = [...store.records.values()][0];
  for (let i = 0; i < 3; i++) {
    const replay = await store.start(original);
    assert.equal(replay.run_id, existing.run_id);
    assert.equal(replay.status, fail ? "MODEL_FAILED" : "PENDING_RISK");
    assert.equal(replay.execution.receipt, null);
  }
  assert.deepEqual(request, original);
  assert.equal(calls.length, 1); assert.ok(calls[0].context.demo_funding_snapshot);
  for (const change of [{ text: "改为投入6000元" }, { context: { user_note: "改变用途" } },
    { action_parameters: { ...original.action_parameters, amount: 6000 } },
    { action_parameters: { ...original.action_parameters, funding_plan_revision: 2 } }]) {
    await assert.rejects(store.start({ ...original, ...change }), { code: "IDEMPOTENCY_CONFLICT" });
  }
  assert.equal(calls.length, 1);
});

test("replaying an approved request after plan revision cannot refresh its approval or execute it", async () => {
  const { store, plans, plan, request, calls, definition } = fixture();
  const record = await store.start(request), binding = { task_id: record.task_id, proposal_sha256: record.proposed_action.proposal_sha256 };
  await store.decideRisk({ ...binding, decision: "APPROVE", reviewer: "synthetic-risk", reason: "Test" });
  const approved = await store.decideApproval({ ...binding, decision: "APPROVE", approver: "synthetic-user", reason: "PAPER only" });
  plans.revise({ ...definition, cash_minor: 2000000, plan_id: plan.plan_id, expected_revision: 1 });
  const replay = await store.start(request);
  assert.equal(replay.run_id, record.run_id);
  assert.deepEqual(replay.proposed_action, approved.proposed_action);
  assert.deepEqual(replay.approval, approved.approval);
  await assert.rejects(store.simulate(binding), { code: "FUNDING_PLAN_CHANGED" });
  assert.equal(plans.summary(plan.plan_id).allocations.length, 0);
  assert.equal(calls.length, 1);
});
