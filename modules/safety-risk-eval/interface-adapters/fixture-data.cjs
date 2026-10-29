"use strict";
const { createHash } = require("node:crypto");
const { buildRiskHandoffPackage } = require("../../../chenchen/integrations/risk-handoff.js");
const POLICY_VERSION = "daily-cashflow-policy.v1.0";
const AT = "2026-10-21T04:00:00.000Z";
const sha = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const DEFINITIONS = {
  ALLOW: [],
  REVIEW: [{ rule_id: "D01", code: "DAILY_DATA_REQUIRED", message_zh: "本次手续费未知，需要补齐后重新检查。", status: "REVIEW" }],
  BLOCK: [{ rule_id: "D02", code: "PROTECTED_PURPOSE_CONFLICT", message_zh: "本次安排占用了已经确认的学费保护资金。", status: "BLOCK" }],
  ERROR: [{ rule_id: "D01", code: "DAILY_CHECK_UNAVAILABLE", message_zh: "必需的资金计算不可用，本次检查失败。", status: "ERROR" }]
};

// Synthetic structural fixtures only. A successful model flag here is a test
// double, never evidence of a provider call, signed identity or verified account.
function assessmentFor(handoff, decision) {
  if (!Object.hasOwn(DEFINITIONS, decision)) throw new Error("Unknown fixture decision");
  const tag = decision.toLowerCase();
  return {
    risk_check_id: `fixture-risk-check-${tag}-v1`, decision,
    check_complete: decision !== "ERROR", checked_at: AT, policy_version: handoff.policy_version,
    core_binding: {
      handoff_id: handoff.handoff_id, task_id: handoff.task_id, request_id: handoff.request_id,
      run_id: handoff.run_id, audit_id: handoff.audit_id, proposal_sha256: handoff.proposal.proposal_sha256
    },
    local_task_id: `fixture-local-risk-task-${tag}-v1`, reasons: structuredClone(DEFINITIONS[decision])
  };
}

function makeFixture(decision) {
  const tag = decision.toLowerCase(), taskId = `fixture-core-task-${tag}-v1`, runId = `fixture-core-run-${tag}-v1`, auditId = `fixture-core-audit-${tag}-v1`;
  const proposal = {
    proposed_action: "HOLD_FOR_REVIEW", action_reason: "虚构资料的资金安排，需要独立风险检查及用户确认。", risk_level: "medium",
    requested_action: "只评审虚构资金安排，不执行真实交易。",
    action_parameters: { amount: "2000.00", amount_unit: "YUAN", currency: "CNY" },
    model_response_id: `fixture-provider-${tag}-not-a-live-call`
  };
  const proposalHash = sha(proposal), inputHash = sha({ fixture: tag }), handoffId = `fixture-handoff-${tag}-v1`;
  const record = {
    workflow_version: "review-workflow.v1", schema_version: "model-review.v1",
    task_id: taskId, request_id: `fixture-core-request-${tag}-v1`, session_id: `fixture-session-${tag}`, run_id: runId,
    data_mode: "SYNTHETIC_REPLAY", execution_mode: "PAPER", capability: "SIMULATION_ONLY",
    plan_id: `fixture-core-plan-${tag}`, plan_hash: proposalHash, policy_version: POLICY_VERSION,
    status: "PENDING_RISK", memory_write_status: "NOT_REQUESTED",
    reviewed_input: { text: "虚构接口样例，无真实账户资料。", source_task_id: `fixture-previous-core-task-${tag}-v1` },
    proposed_action: { ...proposal, proposal_sha256: proposalHash },
    model: { source: "model", status: "PROPOSED", model_response: { call_succeeded: true, model: "TEST_DOUBLE_NOT_A_LIVE_MODEL", provider_response_id: proposal.model_response_id } },
    risk_handoff: {
      handoff_id: handoffId, status: "PENDING_REVIEW", decision: "REQUIRED", owner: "Unified Risk", execution_allowed: false,
      evidence: { input_sha256: inputHash, proposal_sha256: proposalHash, audit_id: auditId, model_response_id: proposal.model_response_id, plan_id: `fixture-core-plan-${tag}`, plan_hash: proposalHash, policy_version: POLICY_VERSION }
    },
    approval: { approval_id: `fixture-core-approval-${tag}`, task_id: taskId, required: true, status: "BLOCKED", decision: null, proposal_sha256: proposalHash, approver: null, decided_at: null, expires_at: null },
    audit: { audit_id: auditId, events: [{ event_id: `fixture-event-${tag}`, task_id: taskId, actor: "TEST_DOUBLE", event_type: "fixture.created", payload: { request_id: `fixture-core-request-${tag}-v1`, run_id: runId }, timestamp: AT }] }
  };
  const handoff = buildRiskHandoffPackage(record);
  return { handoff, risk_result: assessmentFor(handoff, decision), reviewer: "fixture-risk-reviewer-not-an-authenticated-identity" };
}
module.exports = { makeFixture, assessmentFor, POLICY_VERSION };
