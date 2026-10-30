"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { ReviewWorkflowStore } = require("../integrations/review-workflow");
const { FundingPlanStore } = require("../integrations/funding-plan");

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function setup({ funded = false, memoryWriter = null } = {}) {
  const plans = new FundingPlanStore();
  const plan = funded ? plans.create({ synthetic: true, confirmed: true, currency: "CNY", cash_minor: 1000000,
    protected_purposes: [{ purpose_id: "rent", label: "Synthetic rent", amount_minor: 400000 }] }) : null;
  const store = new ReviewWorkflowStore({ fundingPlans: plans, memoryWriter, modelRunner: async () => ({
    run_id: "synthetic-run-" + randomUUID(), source: "model", status: "PROPOSED",
    input: { input_sha256: "a".repeat(64) },
    model_response: { provider_response_id: "synthetic-response", proposal: {
      proposed_action: "HOLD_FOR_REVIEW", action_reason: "Synthetic review only", risk_level: "low" } },
    audit: { audit_id: "synthetic-audit-" + randomUUID(), events: [] }
  }) });
  const created = await store.start({ capability: "SIMULATION_ONLY", text: "Synthetic investment after rent", memory_consent: true,
    ...(plan ? { action_parameters: { synthetic: true, currency: "CNY", amount: 4000,
      funding_plan_id: plan.plan_id, funding_plan_revision: plan.revision } } : {}) });
  const input = { task_id: created.task_id, proposal_sha256: created.proposed_action.proposal_sha256 };
  await store.decideRisk({ ...input, decision: "APPROVE", reviewer: "synthetic-risk", reason: "PAPER test" });
  await store.decideApproval({ ...input, decision: "APPROVE", approver: "synthetic-user", reason: "PAPER test" });
  return { store, plans, plan, input };
}

function pastDeadline(store, input) {
  const record = store.getByTaskId(input.task_id);
  record.approval.expires_at = new Date(Date.now() - 1000).toISOString();
  store.save(record);
}

test("an approved but expired task cannot allocate funds or write Memory", async () => {
  let writes = 0;
  const { store, plans, plan, input } = await setup({ funded: true, memoryWriter: async () => { writes++; } });
  pastDeadline(store, input);
  await assert.rejects(store.simulate(input), e => e.code === "APPROVAL_EXPIRED" && e.record.status === "EXPIRED");
  await assert.rejects(store.simulate(input), e => e.code === "EXECUTION_BLOCKED");
  const record = store.getByTaskId(input.task_id);
  assert.equal(record.execution.receipt, null);
  assert.equal(record.execution.simulation_allowed, false);
  assert.equal(plans.summary(plan.plan_id).allocated_minor, 0);
  assert.equal(writes, 0);
  assert.equal(record.audit.events.filter(e => e.event_type === "approval.expired").length, 1);
});

test("expiry never rewrites a completed receipt or terminal audit", async () => {
  const { store, input } = await setup();
  const completed = await store.simulate(input);
  pastDeadline(store, input);
  await assert.rejects(store.decideApproval({ ...input, decision: "APPROVE", approver: "synthetic-user", reason: "PAPER test" }), e => e.code === "WORKFLOW_TERMINAL");
  await assert.rejects(store.decideRisk({ ...input, decision: "APPROVE", reviewer: "synthetic-risk", reason: "PAPER test" }), e => e.code === "WORKFLOW_TERMINAL");
  const replay = await store.simulate(input);
  assert.equal(replay.status, "SIMULATED");
  assert.deepEqual(replay.execution.receipt, completed.execution.receipt);
  assert.equal(replay.audit.events.filter(e => e.event_type === "approval.expired").length, 0);
});

for (const funded of [false, true]) {
  test(`slow Memory and ten retries keep one receipt and write (funded=${funded})`, { timeout: 5000 }, async () => {
    const gate = deferred(), entered = deferred(); let writes = 0; const argumentsSeen = [];
    const { store, plans, plan, input } = await setup({ funded, memoryWriter: async (...args) => {
      argumentsSeen.push(args); writes++; entered.resolve();
      if (writes === 1) await gate.promise;
      return { memory_id: "synthetic-memory" };
    } });
    const first = store.simulate(input);
    await entered.promise;
    const retries = await Promise.allSettled(Array.from({ length: 10 }, () => store.simulate(input)));
    gate.resolve();
    const completed = await first;
    assert.equal(writes, 1);
    for (const retry of retries) {
      assert.equal(retry.status, "fulfilled");
      assert.deepEqual(retry.value.execution.receipt, completed.execution.receipt);
      assert.equal(retry.value.memory_write_status, "PENDING");
    }
    assert.equal(completed.memory_write_status, "WRITTEN");
    assert.equal(argumentsSeen[0][1].consent, true);
    assert.equal(argumentsSeen[0][1].key, "review:" + input.task_id);
    assert.equal(argumentsSeen[0][1].value.status, "SIMULATED");
    assert.equal(completed.audit.events.filter(e => e.event_type === "execution.simulated").length, 1);
    if (funded) assert.equal(plans.summary(plan.plan_id).allocations.length, 1);
  });
}

for (const fails of [false, true]) {
  test(`late cancellation is blocked and its audit survives Memory completion (fails=${fails})`, { timeout: 5000 }, async () => {
    const gate = deferred(), entered = deferred();
    const { store, input } = await setup({ memoryWriter: async () => {
      entered.resolve(); await gate.promise;
      if (fails) throw Object.assign(new Error("Synthetic Memory outage"), { code: "SYNTHETIC_MEMORY_OUTAGE" });
      return { memory_id: "synthetic-memory" };
    } });
    const first = store.simulate(input);
    await entered.promise;
    const pending = store.getByTaskId(input.task_id);
    const cancellation = await Promise.allSettled([store.cancel({ ...input, canceler: "synthetic-user", reason: "Late click" })]);
    gate.resolve();
    const completed = await first;
    assert.equal(pending.status, "SIMULATED");
    assert.equal(pending.memory_write_status, "PENDING");
    assert.equal(cancellation[0].status, "rejected");
    assert.equal(cancellation[0].reason.code, "WORKFLOW_TERMINAL");
    assert.deepEqual(completed.execution.receipt, pending.execution.receipt);
    assert.equal(completed.memory_write_status, fails ? "FAILED" : "WRITTEN");
    const events = completed.audit.events;
    assert.equal(events.filter(e => e.event_type === "workflow.operation_blocked").length, 1);
    assert.ok(events.some(e => e.event_type === (fails ? "memory.write.failed" : "memory.saved")));
    assert.equal(events.filter(e => e.event_type === "execution.simulated").length, 1);
    assert.deepEqual((await store.simulate(input)).execution.receipt, completed.execution.receipt);
  });
}
