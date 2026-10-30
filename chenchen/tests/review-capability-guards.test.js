"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { randomUUID } = require("node:crypto");
const { ReviewWorkflowStore } = require("../integrations/review-workflow");
const { FundingPlanStore } = require("../integrations/funding-plan");
const { signatureFor, verifyOwnerRequest } = require("../integrations/owner-bridge");

async function setup(capability) {
  const plans = new FundingPlanStore();
  const plan = plans.create({ synthetic: true, confirmed: true, currency: "CNY", cash_minor: 1000000,
    protected_purposes: [{ purpose_id: "rent", label: "Synthetic rent", amount_minor: 400000 }] });
  const store = new ReviewWorkflowStore({ fundingPlans: plans, modelRunner: async input => ({
    run_id: "synthetic-capability-" + randomUUID(), source: "model", status: "PROPOSED",
    input: { input_sha256: "a".repeat(64), capability: input.capability },
    model_response: { call_succeeded: true, provider_response_id: "TEST_DOUBLE_NOT_LIVE", proposal: {
      proposed_action: "HOLD_FOR_REVIEW", action_reason: "Synthetic capability regression", risk_level: "low" } },
    audit: { audit_id: "synthetic-audit-" + randomUUID(), events: [] }
  }) });
  const created = await store.start({ text: "Synthetic investment protecting rent", data_mode: "SYNTHETIC_REPLAY",
    ...(capability === undefined ? {} : { capability }), action_parameters: {
      synthetic: true, currency: "CNY", amount: 2000, funding_plan_id: plan.plan_id, funding_plan_revision: plan.revision
    } });
  const base = { task_id: created.task_id, proposal_sha256: created.proposed_action.proposal_sha256 };
  const risk = { ...base, decision: "APPROVE", reviewer: "synthetic-risk-owner", reason: "Synthetic risk decision" };
  const riskSecret = "synthetic-test-risk-secret";
  const riskAuth = await verifyOwnerRequest({ owner: "risk", body: risk,
    headers: new Headers({ "X-Risk-Signature": await signatureFor(risk, riskSecret) }),
    env: { REQUIRE_TRUSTED_ACTORS: "true", RISK_SERVICE_HMAC_SECRET: riskSecret } });
  const checked = await store.decideRisk(risk, riskAuth);
  const approval = { ...base, decision: "APPROVE", approver: "synthetic-confirmed-user", reason: "Synthetic PAPER confirmation" };
  const approvalSecret = "synthetic-test-approval-secret";
  const approvalAuth = await verifyOwnerRequest({ owner: "approval", body: approval,
    headers: new Headers({ "X-Approval-Signature": await signatureFor(approval, approvalSecret) }),
    env: { REQUIRE_TRUSTED_ACTORS: "true", APPROVAL_SERVICE_HMAC_SECRET: approvalSecret } });
  return { store, plans, plan, base, checked, approval, approvalAuth };
}

for (const capability of [undefined, "REVIEW_ONLY"]) {
  test(`signed Risk and approval cannot upgrade ${capability ?? "default"} review capability`, async () => {
    const { store, plans, plan, base, checked, approval, approvalAuth } = await setup(capability);
    assert.equal(checked.capability, "REVIEW_ONLY");
    assert.equal(checked.status, "PENDING_APPROVAL");
    assert.equal(checked.execution.simulation_allowed, false);
    await assert.rejects(store.decideApproval(approval, approvalAuth), { code: "SIMULATION_CAPABILITY_REQUIRED", stage: "APPROVAL" });
    const saved = store.getByTaskId(base.task_id);
    assert.equal(saved.status, "PENDING_APPROVAL");
    assert.equal(saved.approval.status, "PENDING");
    assert.equal(saved.risk_decision.auth.verified, true);
    assert.equal(saved.execution.simulation_allowed, false);
    assert.equal(saved.execution.execution_allowed, false);
    assert.equal(saved.execution.receipt, null);
    assert.equal(plans.summary(plan.plan_id).allocated_minor, 0);
    assert.ok(saved.audit.events.some(event => event.event_type === "workflow.operation_blocked" &&
      event.payload.code === "SIMULATION_CAPABILITY_REQUIRED" && event.payload.stage === "APPROVAL"));
    await assert.rejects(store.simulate(base), { code: "EXECUTION_BLOCKED" });
  });
}

for (const corruption of ["legacy_read_only", "missing", "unknown", "top_level_upgrade", "reviewed_input_upgrade"]) {
  test(`approval and simulation recheck ${corruption} capability in stored records`, async () => {
    const { store, plans, plan, base, approval, approvalAuth } = await setup("SIMULATION_ONLY");
    const saved = store.getByTaskId(base.task_id);
    if (corruption === "legacy_read_only") {
      saved.capability = "REVIEW_ONLY";
      saved.reviewed_input.capability = "REVIEW_ONLY";
    } else if (corruption === "missing") {
      delete saved.capability;
      delete saved.reviewed_input;
    } else if (corruption === "unknown") {
      saved.capability = "UNKNOWN";
      saved.reviewed_input.capability = "UNKNOWN";
    } else if (corruption === "top_level_upgrade") saved.reviewed_input.capability = "REVIEW_ONLY";
    else saved.capability = "REVIEW_ONLY";
    store.save(saved);
    await assert.rejects(store.decideApproval(approval, approvalAuth), { code: "SIMULATION_CAPABILITY_REQUIRED", stage: "APPROVAL" });
    const legacy = store.getByTaskId(base.task_id);
    assert.equal(legacy.approval.status, "PENDING");
    // Reproduce a stored legacy approval without authorizing a fresh transition.
    legacy.approval.status = "APPROVED";
    legacy.approval.decision = "APPROVE";
    legacy.status = "READY_FOR_SIMULATION";
    legacy.execution.status = "READY";
    legacy.execution.simulation_allowed = true;
    store.save(legacy);
    await assert.rejects(store.simulate(base), { code: "SIMULATION_CAPABILITY_REQUIRED", stage: "EXECUTION" });
    const result = store.getByTaskId(base.task_id);
    assert.equal(result.status, "PENDING_APPROVAL");
    assert.equal(result.execution.status, "BLOCKED");
    assert.equal(result.execution.simulation_allowed, false);
    assert.equal(result.execution.execution_allowed, false);
    assert.equal(result.execution.receipt, null);
    assert.equal(result.approval.status, "APPROVED");
    assert.equal(plans.summary(plan.plan_id).allocated_minor, 0);
    assert.equal(result.audit.events.at(-1).payload.code, "SIMULATION_CAPABILITY_REQUIRED");
    assert.equal(result.audit.events.at(-1).payload.stage, "EXECUTION");
  });
}

test("an explicitly reviewed simulation keeps one receipt and preserves completed history", async () => {
  const { store, plans, plan, base, approval, approvalAuth } = await setup("SIMULATION_ONLY");
  const approved = await store.decideApproval(approval, approvalAuth);
  assert.equal(approved.status, "READY_FOR_SIMULATION");
  assert.equal(approved.execution.simulation_allowed, true);
  const completed = await store.simulate(base);
  assert.equal(completed.status, "SIMULATED");
  assert.equal(completed.execution.receipt.side_effects, false);
  assert.equal(completed.execution.execution_allowed, false);
  const legacy = store.getByTaskId(base.task_id);
  delete legacy.capability;
  store.save(legacy);
  const replayed = await store.simulate(base);
  assert.deepEqual(replayed.execution.receipt, completed.execution.receipt);
  assert.equal(plans.summary(plan.plan_id).allocations.length, 1);
  assert.equal(replayed.audit.events.filter(event => event.event_type === "execution.simulated").length, 1);
});

test("NO_ACTION simulation readiness requires an explicitly reviewed simulation capability", async () => {
  for (const capability of [undefined, "REVIEW_ONLY", "SIMULATION_ONLY"]) {
    const store = new ReviewWorkflowStore({ modelRunner: async () => ({
      run_id: "synthetic-no-action-" + randomUUID(), source: "model", status: "PROPOSED",
      input: { input_sha256: "a".repeat(64) },
      model_response: { provider_response_id: null, proposal: { proposed_action: "NO_ACTION", action_reason: "Synthetic answer", risk_level: "low" } },
      audit: { audit_id: "synthetic-no-action-audit-" + randomUUID(), events: [] }
    }) });
    const created = await store.start({ text: "Synthetic question", ...(capability === undefined ? {} : { capability }) });
    const base = { task_id: created.task_id, proposal_sha256: created.proposed_action.proposal_sha256 };
    const checked = await store.decideRisk({ ...base, decision: "APPROVE", reviewer: "synthetic-risk", reason: "Synthetic" });
    const canSimulate = capability === "SIMULATION_ONLY";
    assert.equal(checked.approval.required, false);
    assert.equal(checked.status, canSimulate ? "READY_FOR_SIMULATION" : "PENDING_APPROVAL");
    assert.equal(checked.execution.simulation_allowed, canSimulate);
    assert.equal(checked.execution.execution_allowed, false);
    assert.equal(checked.audit.events.some(event => event.event_type === "execution.ready_for_simulation"), canSimulate);
    if (canSimulate) assert.equal((await store.simulate(base)).status, "SIMULATED");
    else await assert.rejects(store.simulate(base), { code: "EXECUTION_BLOCKED" });
  }
});
