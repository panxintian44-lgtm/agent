"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { ReviewError, normalizeReviewInput, runReview } = require("../integrations/model-review");
const { ReviewWorkflowStore, WorkflowError } = require("../integrations/review-workflow");
const { buildRiskHandoffPackage } = require("../integrations/risk-handoff");

const proposal = {
  summary: "需要人工核对这笔资金安排。",
  risk_level: "medium",
  proposed_action: "HOLD_FOR_REVIEW",
  action_reason: "模型只能提出建议，不能替代 Risk 和人工确认。",
  missing_information: [],
  evidence: ["synthetic fixture"]
};

function fakeReview(input) {
  return Promise.resolve({
    review_version: "model-review.v1",
    schema_version: "model-review.v1",
    run_id: "review-gate-" + input.task_id,
    request_id: input.request_id,
    task_id: input.task_id,
    status: "PROPOSED",
    source: "model",
    input: {
      schema_version: "model-review.v1",
      kind: input.kind,
      source: input.source,
      input_sha256: "a".repeat(64),
      session_id: input.session_id,
      data_mode: input.data_mode,
      execution_mode: input.execution_mode,
      capability: input.capability,
      risk_profile_version: input.risk_profile_version,
      policy_version: input.policy_version
    },
    model_response: {
      model: "synthetic-model",
      provider_response_id: "response-" + input.task_id,
      call_succeeded: true,
      data_mode: input.data_mode,
      execution_mode: input.execution_mode,
      capability: input.capability,
      proposal
    },
    audit: { audit_id: "audit-" + input.task_id, events: [] }
  });
}

function base(overrides = {}) {
  return {
    request_id: "req-gate-001",
    kind: "bill",
    source: "synthetic-review-fixture",
    text: "虚构账单：下个月有固定支出，拟议动作需要人工复核。",
    data_mode: "SYNTHETIC_REPLAY",
    execution_mode: "PAPER",
    capability: "REVIEW_ONLY",
    portfolio_snapshot_id: "snapshot-gate-001",
    risk_profile_version: "risk-profile.v7",
    policy_version: "risk-policy.v3",
    idempotency_key: "idem-gate-001",
    memory_consent: false,
    ...overrides
  };
}

test("T01: missing review evidence stays at input validation", () => {
  assert.throws(() => normalizeReviewInput({ kind: "bill" }), error => error instanceof ReviewError && error.code === "INVALID_REVIEW_INPUT");
});

test("T02: the request binds schema, data mode, execution mode and policy versions", () => {
  const input = normalizeReviewInput(base());
  assert.equal(input.schema_version, "model-review.v1");
  assert.equal(input.data_mode, "SYNTHETIC_REPLAY");
  assert.equal(input.execution_mode, "PAPER");
  assert.equal(input.risk_profile_version, "risk-profile.v7");
  assert.equal(input.policy_version, "risk-policy.v3");
});

test("T03: Risk approval creates one expiring approval bound to the plan hash", async () => {
  const store = new ReviewWorkflowStore({ modelRunner: fakeReview, approvalTtlMs: 60_000 });
  const created = await store.start(base());
  const approved = await store.decideRisk({ task_id: created.task_id, proposal_sha256: created.proposed_action.proposal_sha256, decision: "APPROVE", reviewer: "risk-owner", reason: "证据足够，进入人工审批" });
  assert.equal(approved.status, "PENDING_APPROVAL");
  assert.match(approved.approval.expires_at, /^20/);
  assert.equal(approved.approval.proposal_sha256, approved.plan_hash);
});

test("T04: execution remains blocked before Risk and approval", async () => {
  const store = new ReviewWorkflowStore({ modelRunner: fakeReview });
  const created = await store.start(base({ idempotency_key: null }));
  await assert.rejects(store.simulate({ task_id: created.task_id, proposal_sha256: created.proposed_action.proposal_sha256 }), error => error.code === "EXECUTION_BLOCKED");
});

test("T05: explicit Memory consent is visible and can be written through the existing Memory rule", async () => {
  let writes = 0;
  const store = new ReviewWorkflowStore({ modelRunner: fakeReview, memoryWriter: async (_sessionId, record) => {
    writes += 1;
    assert.equal(record.consent, true);
    return { memory_id: "memory-gate-001" };
  } });
  const created = await store.start(base({ memory_consent: true, idempotency_key: null, capability: "SIMULATION_ONLY" }));
  const risk = await store.decideRisk({ task_id: created.task_id, proposal_sha256: created.proposed_action.proposal_sha256, decision: "APPROVE", reviewer: "risk-owner", reason: "通过" });
  const approval = await store.decideApproval({ task_id: created.task_id, proposal_sha256: risk.proposed_action.proposal_sha256, decision: "APPROVE", approver: "user", reason: "我已确认" });
  const done = await store.simulate({ task_id: approval.task_id, proposal_sha256: approval.proposed_action.proposal_sha256 });
  assert.equal(writes, 1);
  assert.equal(done.memory_write_status, "WRITTEN");
  assert.equal(done.memory_id, "memory-gate-001");
});

test("T06: handoff and audit share the same trace identifiers", async () => {
  const store = new ReviewWorkflowStore({ modelRunner: fakeReview });
  const created = await store.start(base({ idempotency_key: null }));
  const handoff = buildRiskHandoffPackage(created);
  assert.equal(handoff.session_id, created.session_id);
  assert.equal(handoff.trace.task_id, created.task_id);
  assert.equal(handoff.trace.audit_id, created.audit.audit_id);
  assert.equal(handoff.evidence.plan_hash, created.plan_hash);
  assert.ok(created.audit.events.every(item => item.payload.trace.task_id === created.task_id));
});

test("T07: Risk rejection is terminal and cannot reach simulation", async () => {
  const store = new ReviewWorkflowStore({ modelRunner: fakeReview });
  const created = await store.start(base({ idempotency_key: null }));
  const rejected = await store.decideRisk({ task_id: created.task_id, proposal_sha256: created.proposed_action.proposal_sha256, decision: "REJECT", reviewer: "risk-owner", reason: "资金用途冲突" });
  assert.equal(rejected.status, "REJECTED");
  await assert.rejects(store.simulate({ task_id: created.task_id, proposal_sha256: created.proposed_action.proposal_sha256 }), error => error.code === "EXECUTION_BLOCKED");
});

test("T08: unsupported live execution mode is rejected before model invocation", () => {
  assert.throws(() => normalizeReviewInput(base({ execution_mode: "LIVE" })), error => error.code === "EXECUTION_MODE_NOT_SUPPORTED");
});

test("T09: proposal hash changes cannot be approved", async () => {
  const store = new ReviewWorkflowStore({ modelRunner: fakeReview });
  const created = await store.start(base({ idempotency_key: null }));
  await assert.rejects(store.decideRisk({ task_id: created.task_id, proposal_sha256: "f".repeat(64), decision: "APPROVE", reviewer: "risk-owner", reason: "测试" }), error => error.code === "PROPOSAL_CHANGED");
});

test("T10: Risk callback with a different task or audit is blocked", async () => {
  const store = new ReviewWorkflowStore({ modelRunner: fakeReview });
  const created = await store.start(base({ idempotency_key: null }));
  const callback = {
    callback_version: "risk-callback.v1",
    handoff_id: created.risk_handoff.handoff_id,
    task_id: created.task_id,
    request_id: created.request_id,
    run_id: created.run_id,
    audit_id: "wrong-audit",
    proposal_sha256: created.proposed_action.proposal_sha256,
    decision: "APPROVE",
    reviewer: "risk-owner",
    reason: "证据足够"
  };
  await assert.rejects(store.receiveRiskCallback(callback), error => error.code === "RISK_HANDOFF_MISMATCH");
});

test("T11: rule fallback requires an explicitly enabled backend mode", async () => {
  await assert.rejects(runReview({ text: "疑似诈骗，需要核查", allow_rule_fallback: true }, {}, { fetchImpl: async () => { throw new Error("should not call"); } }), error => error.code === "MODEL_NOT_CONFIGURED");
  const fallback = await runReview({ text: "疑似诈骗，需要核查", allow_rule_fallback: true }, { MODEL_FALLBACK_TO_RULES: "true" }, { fetchImpl: async () => { throw new Error("should not call"); } });
  assert.equal(fallback.source, "rule_fallback");
  assert.equal(fallback.gateway.execution_allowed, false);
});

test("T12: an expired approval blocks both approval and simulation", async () => {
  const store = new ReviewWorkflowStore({ modelRunner: fakeReview, approvalTtlMs: 1 });
  const created = await store.start(base({ idempotency_key: null }));
  const risk = await store.decideRisk({ task_id: created.task_id, proposal_sha256: created.proposed_action.proposal_sha256, decision: "APPROVE", reviewer: "risk-owner", reason: "通过" });
  await new Promise(resolve => setTimeout(resolve, 5));
  await assert.rejects(store.decideApproval({ task_id: risk.task_id, proposal_sha256: risk.proposed_action.proposal_sha256, decision: "APPROVE", approver: "user", reason: "确认" }), error => error.code === "APPROVAL_EXPIRED");
  assert.equal(store.getByTaskId(created.task_id).status, "EXPIRED");
});

test("T13: the same idempotency key replays the same task and rejects changed input", async () => {
  const store = new ReviewWorkflowStore({ modelRunner: fakeReview });
  const first = await store.start(base());
  const replay = await store.start(base({ request_id: "req-other" }));
  assert.equal(replay.task_id, first.task_id);
  await assert.rejects(store.start(base({ text: "内容已经改变" })), error => error.code === "IDEMPOTENCY_CONFLICT");
});

test("T14: a model failure creates a blocked auditable record with no execution authority", async () => {
  const store = new ReviewWorkflowStore({ modelRunner: async () => {
    const error = new Error("provider unavailable");
    error.code = "MODEL_PROVIDER_UNAVAILABLE";
    error.retryable = true;
    throw error;
  } });
  await assert.rejects(store.start(base({ idempotency_key: null })), error => {
    assert.equal(error.workflowRecord.status, "MODEL_FAILED");
    assert.equal(error.workflowRecord.execution.execution_allowed, false);
    assert.ok(error.workflowRecord.audit.events.some(item => item.event_type === "execution.blocked"));
    return true;
  });
});
