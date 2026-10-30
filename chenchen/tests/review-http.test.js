"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { randomUUID } = require("node:crypto");
const { server, reviewWorkflow } = require("../server");

function fakeReview(input) {
  const proposal = {
    summary: "模型建议先复核账单",
    risk_level: "medium",
    proposed_action: "HOLD_FOR_REVIEW",
    action_reason: "付款动作必须先经过 Risk 和人工审批",
    missing_information: ["付款状态"],
    evidence: ["账单金额"]
  };
  return Promise.resolve({
    review_version: "model-review.v1", run_id: "review-http-fake-" + randomUUID(), request_id: input.request_id, task_id: input.task_id,
    status: "PROPOSED", source: "model",
    input: { kind: input.kind, source: input.source, input_sha256: "b".repeat(64) },
    model_response: { model: "fake-model", provider_response_id: "resp-http-fake-001", raw_text: JSON.stringify(proposal), proposal, usage: { input_tokens: 1, output_tokens: 1 } },
    audit: { audit_id: "audit-http-fake-001", events: [{ event_type: "review.received", at: new Date().toISOString() }] }
  });
}

test("HTTP model-to-Risk-to-approval-to-simulation chain is queryable", async t => {
  const previousRunner = reviewWorkflow.modelRunner;
  reviewWorkflow.reset();
  reviewWorkflow.modelRunner = fakeReview;
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    reviewWorkflow.modelRunner = previousRunner;
    reviewWorkflow.reset();
    server.closeAllConnections();
    server.close();
  });
  const base = "http://127.0.0.1:" + server.address().port;
  const headers = { "Content-Type": "application/json" };
  const start = await fetch(base + "/api/review", { method: "POST", headers, body: JSON.stringify({ capability: "SIMULATION_ONLY", request_id: "req-http-workflow-001", kind: "bill", text: "演示账单 1280 元", requested_action: "进入付款准备", action_parameters: { amount: 1280 } }) });
  assert.equal(start.status, 200);
  const created = await start.json();
  assert.equal(created.status, "PENDING_RISK");
  assert.equal(created.model.model_response.raw_text.length > 0, true);

  const blocked = await fetch(base + "/api/review/simulate", { method: "POST", headers, body: JSON.stringify({ task_id: created.task_id, proposal_sha256: created.proposed_action.proposal_sha256 }) });
  assert.equal(blocked.status, 409);
  assert.equal((await blocked.json()).error.code, "EXECUTION_BLOCKED");

  const risk = await fetch(base + "/api/review/risk-decision", { method: "POST", headers, body: JSON.stringify({ task_id: created.task_id, proposal_sha256: created.proposed_action.proposal_sha256, decision: "APPROVE", reviewer: "risk-owner", reason: "证据充分" }) }).then(r => r.json());
  assert.equal(risk.status, "PENDING_APPROVAL");
  const approval = await fetch(base + "/api/review/approval", { method: "POST", headers, body: JSON.stringify({ task_id: created.task_id, proposal_sha256: created.proposed_action.proposal_sha256, decision: "APPROVE", approver: "approver", reason: "已核对" }) }).then(r => r.json());
  assert.equal(approval.status, "READY_FOR_SIMULATION");
  const simulated = await fetch(base + "/api/review/simulate", { method: "POST", headers, body: JSON.stringify({ task_id: created.task_id, proposal_sha256: created.proposed_action.proposal_sha256 }) }).then(r => r.json());
  assert.equal(simulated.status, "SIMULATED");
  assert.equal(simulated.execution.receipt.side_effects, false);
  const queried = await fetch(base + "/api/review/task/" + encodeURIComponent(created.task_id));
  assert.equal(queried.status, 200);
  const record = await queried.json();
  assert.equal(record.task_id, created.task_id);
  assert.equal(record.audit.audit_id, created.audit.audit_id);
  assert.equal(record.risk_decision.task_id, created.task_id);
  assert.equal(record.approval.task_id, created.task_id);
  assert.equal(record.execution.task_id, created.task_id);
  assert.ok(record.audit.events.some(item => item.event_type === "execution.simulated"));
  const run = await fetch(base + "/api/review/" + encodeURIComponent(created.run_id));
  assert.equal(run.status, 200);
  assert.equal((await run.json()).task_id, created.task_id);

  const legacy = await fetch(base + "/api/review/legacy", {
    method: "POST", headers, body: JSON.stringify({ question: "我想追加投资，但下个月要交房租，是否冲突？", run_id: "legacy-http-001" })
  });
  assert.equal(legacy.status, 200);
  const legacyPayload = await legacy.json();
  assert.equal(legacyPayload.contract_version, "legacy-review.v0");
  assert.equal(legacyPayload.source_contract, "review-workflow.v1");
  assert.equal(legacyPayload.execution_state, "awaiting_risk");
  assert.equal(legacyPayload.gate.execution_allowed, false);
  const handoffResponse = await fetch(base + "/api/review/" + legacyPayload.run_id + "/risk-handoff");
  assert.equal(handoffResponse.status, 200);
  const handoff = await handoffResponse.json();
  assert.equal(handoff.handoff_version, "risk-handoff.v1");
  const callback = {
    callback_version: "risk-callback.v1", handoff_id: handoff.handoff_id,
    task_id: handoff.task_id, request_id: handoff.request_id, run_id: handoff.run_id,
    audit_id: handoff.audit_id, proposal_sha256: handoff.proposal.proposal_sha256,
    decision: "REJECT", reviewer: "synthetic-risk-owner", reason: "Test rejection"
  };
  for (const expected of ["RECORDED", "DUPLICATE"]) {
    const response = await fetch(base + "/api/review/risk-callback", { method: "POST", headers, body: JSON.stringify(callback) });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).callback_status, expected);
  }
  const rejected = await fetch(base + "/api/review/task/" + handoff.task_id + "/risk-handoff").then(r => r.json());
  assert.equal(rejected.workflow_status, "REJECTED");
  assert.equal(rejected.execution_allowed, false);
  const mismatch = await fetch(base + "/api/review/risk-callback", { method: "POST", headers, body: JSON.stringify({ ...callback, audit_id: "wrong" }) });
  assert.equal(mismatch.status, 409);
  assert.equal((await mismatch.json()).error.code, "RISK_HANDOFF_MISMATCH");
  const unchanged = await fetch(base + "/api/review/" + created.run_id).then(r => r.json());
  assert.equal(unchanged.status, "SIMULATED");
  await t.test("Risk dispatch fails closed and leaves an auditable failure when no Owner is configured", async () => {
    const previousUrl = process.env.RISK_SERVICE_URL;
    const previousSecret = process.env.RISK_SERVICE_HMAC_SECRET;
    delete process.env.RISK_SERVICE_URL;
    delete process.env.RISK_SERVICE_HMAC_SECRET;
    try {
      const task = await fetch(base + "/api/review", { method: "POST", headers, body: JSON.stringify({ kind: "bill", text: "Synthetic dispatch configuration test" }) }).then(r => r.json());
      const dispatch = await fetch(base + "/api/review/risk-dispatch", { method: "POST", headers, body: JSON.stringify({ task_id: task.task_id, proposal_sha256: task.proposed_action.proposal_sha256 }) });
      assert.equal(dispatch.status, 503);
      assert.equal((await dispatch.json()).error.code, "RISK_OWNER_NOT_CONFIGURED");
      const record = await fetch(base + "/api/review/task/" + task.task_id).then(r => r.json());
      assert.equal(record.risk_dispatch.status, "FAILED");
      assert.ok(record.audit.events.some(event => event.event_type === "risk.handoff.dispatch_failed"));
      assert.equal(record.execution.execution_allowed, false);
    } finally {
      if (previousUrl === undefined) delete process.env.RISK_SERVICE_URL; else process.env.RISK_SERVICE_URL = previousUrl;
      if (previousSecret === undefined) delete process.env.RISK_SERVICE_HMAC_SECRET; else process.env.RISK_SERVICE_HMAC_SECRET = previousSecret;
    }
  });
  await t.test("HTTP retries require exact approval evidence and return traceable conflicts", async () => {
    const post = (path, body) => fetch(base + path, { method: "POST", headers, body: JSON.stringify(body) });
    const task = await post("/api/review", { capability: "SIMULATION_ONLY", kind: "bill", text: "Synthetic retry test" }).then(r => r.json());
    const binding = { task_id: task.task_id, proposal_sha256: task.proposed_action.proposal_sha256 };
    const risk = { ...binding, decision: "APPROVE", reviewer: "risk", reason: "same" };
    await post("/api/review/risk-decision", risk);
    const original = { ...binding, decision: "APPROVE", approver: "user", reason: "same" };
    const first = await post("/api/review/approval", original).then(r => r.json());
    assert.deepEqual(await post("/api/review/approval", original).then(r => r.json()), first);
    const conflict = await post("/api/review/approval", { ...original, approver: "different" });
    assert.equal(conflict.status, 409);
    const body = await conflict.json();
    assert.equal(body.error.code, "APPROVAL_IMMUTABLE");
    assert.equal(body.trace.audit_id, task.audit.audit_id);
    assert.equal(body.workflow.approval.approver, "user");
    const invalid = await post("/api/review/approval", { ...original, reason: "x".repeat(501) });
    assert.equal(invalid.status, 422);
    const final = await fetch(base + "/api/review/task/" + task.task_id).then(r => r.json());
    assert.equal(final.audit.events.filter(e => e.event_type === "workflow.operation_blocked").length, 2);
    assert.equal(final.execution.execution_allowed, false);
  });
  await t.test("local funding endpoints preserve plan revisions and share the workflow guard", async () => {
    const post = (path, body) => fetch(base + path, { method: "POST", headers, body: JSON.stringify(body) });
    const definition = { synthetic: true, confirmed: true, currency: "CNY", cash_minor: 1000000,
      protected_purposes: [{ purpose_id: "rent", label: "房租", amount_minor: 400000 }] };
    assert.equal((await post("/api/funding-demo/plan", { ...definition, confirmed: false })).status, 422);
    const planResponse = await post("/api/funding-demo/plan", definition);
    assert.equal(planResponse.status, 200);
    const plan = await planResponse.json();
    const task = await post("/api/review", { kind: "bill", text: "synthetic", action_parameters: {
      synthetic: true, currency: "CNY", amount: 8000, funding_plan_id: plan.plan_id, funding_plan_revision: 1
    } }).then(r => r.json());
    assert.equal(task.funding_check.code, "FUNDING_CONFLICT");
    const binding = { task_id: task.task_id, proposal_sha256: task.proposed_action.proposal_sha256 };
    await post("/api/review/risk-decision", { ...binding, decision: "APPROVE", reviewer: "demo", reason: "test" });
    await post("/api/review/approval", { ...binding, decision: "APPROVE", approver: "demo", reason: "test" });
    const blocked = await post("/api/review/simulate", binding);
    assert.equal(blocked.status, 409);
    assert.equal((await blocked.json()).workflow.execution.simulation_allowed, false);
    const revision = await post("/api/funding-demo/plan/revise", { ...definition, plan_id: plan.plan_id, expected_revision: 1 });
    assert.equal(revision.status, 200);
    const reloaded = await fetch(base + "/api/funding-demo/plan/" + plan.plan_id).then(r => r.json());
    assert.equal(reloaded.revision, 1);
    assert.equal(reloaded.allocations.length, 0);
  });
});
