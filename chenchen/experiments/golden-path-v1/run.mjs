import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import worker, { ReviewService } from "../../deployment/worker.js";

const proposal = {
  summary: "虚构账单的收款账户发生变化，需要先核对。",
  risk_level: "high",
  proposed_action: "FLAG_FOR_RISK",
  action_reason: "付款账户变化可能造成资金误付，先交给统一 Risk。",
  missing_information: ["收款账户变更授权"],
  evidence: ["虚构账单中的收款人从公司账户变为个人账户"]
};

function createApp() {
  const records = new Map();
  const storage = {
    async get(key) { return structuredClone(records.get(key)); },
    async put(entries) { for (const [key, value] of Object.entries(entries)) records.set(key, structuredClone(value)); }
  };
  const env = {
    MODEL_PROVIDER: "workers_ai",
    MODEL_DISABLE_RULE_FALLBACK: "true",
    CORS_ORIGINS: "*",
    RATE_LIMIT_PER_MINUTE: "0",
    AI: { run: async () => ({ id: "synthetic-provider-golden-001", response: proposal, usage: { prompt_tokens: 61, completion_tokens: 48 } }) }
  };
  let service = new ReviewService({ storage }, env);
  env.REVIEW_SERVICE = { idFromName: name => name, get: () => service };
  return { env, restart() { service = new ReviewService({ storage }, env); } };
}

function request(pathname, body) {
  return new Request("https://golden-path.invalid" + pathname, body === undefined ? {} : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
  });
}

function trace(record) {
  return {
    task_id: record?.task_id || null,
    request_id: record?.request_id || null,
    run_id: record?.run_id || null,
    audit_id: record?.audit?.audit_id || record?.audit_id || null,
    handoff_id: record?.risk_handoff?.handoff_id || record?.handoff_id || null,
    proposal_sha256: record?.proposed_action?.proposal_sha256 || record?.proposal?.proposal_sha256 || record?.proposal_sha256 || null
  };
}

function eventTypes(record) {
  return (record?.audit?.events || []).map(event => event.event_type);
}

function assertSameTrace(record, handoff) {
  assert.equal(handoff.task_id, record.task_id, "task_id must remain task-bound");
  assert.equal(handoff.request_id, record.request_id, "request_id must remain task-bound");
  assert.equal(handoff.run_id, record.run_id, "run_id must remain task-bound");
  assert.equal(handoff.audit_id, record.audit.audit_id, "audit_id must remain task-bound");
  assert.equal(handoff.proposal.proposal_sha256, record.proposed_action.proposal_sha256);
}

async function call(app, log, flow, step, pathname, body, expectedStatus) {
  const response = await worker.fetch(request(pathname, body), app.env);
  const payload = await response.json();
  assert.equal(response.status, expectedStatus, flow + "/" + step + " HTTP status");
  log.push({
    sequence: log.length + 1,
    flow,
    step,
    endpoint: pathname,
    http_status: response.status,
    status: payload.status || payload.workflow?.status || payload.callback_status || null,
    error_code: payload.error?.code || null,
    callback_status: payload.callback_status || null,
    trace: trace(payload.workflow || payload),
    execution_allowed: payload.execution?.execution_allowed ?? payload.workflow?.execution?.execution_allowed ?? payload.execution_allowed ?? null,
    audit_event_types: eventTypes(payload.workflow || payload)
  });
  return payload;
}

export async function runGoldenPath({ writeArtifacts = true, root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..") } = {}) {
  const app = createApp();
  const log = [];

  const approvedInput = {
    capability: "SIMULATION_ONLY", kind: "bill", source: "synthetic-golden-path", scenario: "FUNDING_CONFLICT",
    text: "虚构供应商账单 1280 元要求改付个人账户，请先核对。",
    idempotency_key: "golden-approved-001", context: { synthetic: true, currency: "CNY" }
  };
  const created = await call(app, log, "approved", "model_proposal", "/api/review", approvedInput, 200);
  assert.equal(created.status, "PENDING_RISK");
  assert.equal(created.model.source, "model");
  assert.equal(created.model.model_response.call_succeeded, true);
  assert.equal(created.model.model_response.provider_response_id, "synthetic-provider-golden-001");
  assert.equal(created.execution.execution_allowed, false);

  const binding = { task_id: created.task_id, proposal_sha256: created.proposed_action.proposal_sha256 };
  const blockedBeforeRisk = await call(app, log, "approved", "execution_blocked_before_risk", "/api/review/simulate", binding, 409);
  assert.equal(blockedBeforeRisk.error.code, "EXECUTION_BLOCKED");

  const handoff = await call(app, log, "approved", "risk_handoff_read", "/api/review/task/" + encodeURIComponent(created.task_id) + "/risk-handoff", undefined, 200);
  assert.equal(handoff.handoff_version, "risk-handoff.v1");
  assertSameTrace(created, handoff);
  assert.equal(handoff.execution_allowed, false);

  const riskCallback = {
    callback_version: "risk-callback.v1", handoff_id: handoff.handoff_id,
    task_id: handoff.task_id, request_id: handoff.request_id, run_id: handoff.run_id,
    audit_id: handoff.audit_id, proposal_sha256: handoff.proposal.proposal_sha256,
    decision: "APPROVE", reviewer: "synthetic-risk-owner", reason: "虚构证据足够，允许进入人工审批。"
  };
  const risk = await call(app, log, "approved", "risk_approved", "/api/review/risk-callback", riskCallback, 200);
  assert.equal(risk.callback_status, "RECORDED");
  assert.equal(risk.workflow.status, "PENDING_APPROVAL");
  assert.equal(risk.workflow.execution.execution_allowed, false);

  const approval = await call(app, log, "approved", "human_approved", "/api/review/approval", {
    ...binding, decision: "APPROVE", approver: "synthetic-user", reason: "已查看 Risk 结果和原始虚构账单。"
  }, 200);
  assert.equal(approval.status, "READY_FOR_SIMULATION");
  assert.equal(approval.execution.execution_allowed, false);

  const simulated = await call(app, log, "approved", "paper_simulation", "/api/review/simulate", binding, 200);
  assert.equal(simulated.status, "SIMULATED");
  assert.equal(simulated.execution.receipt.mode, "SIMULATED");
  assert.equal(simulated.execution.receipt.side_effects, false);
  assert.equal(simulated.execution.execution_allowed, false);

  app.restart();
  const finalApproved = await call(app, log, "approved", "audit_replay", "/api/review/task/" + encodeURIComponent(created.task_id), undefined, 200);
  assert.equal(finalApproved.status, "SIMULATED");
  assert.equal(finalApproved.risk_decision.decision, "APPROVE");
  assert.equal(finalApproved.approval.decision, "APPROVE");
  assert.equal(finalApproved.execution.receipt.side_effects, false);
  assertSameTrace(finalApproved, await call(app, log, "approved", "handoff_replay", "/api/review/task/" + encodeURIComponent(created.task_id) + "/risk-handoff", undefined, 200));
  const approvedEvents = eventTypes(finalApproved);
  for (const required of ["model.completed", "risk.callback.recorded", "approval.approved", "execution.simulated"]) assert.ok(approvedEvents.includes(required), required + " audit event");
  assert.ok(approvedEvents.indexOf("risk.callback.recorded") < approvedEvents.indexOf("approval.approved"));
  assert.ok(approvedEvents.indexOf("approval.approved") < approvedEvents.indexOf("execution.simulated"));

  const rejectedInput = { ...approvedInput, idempotency_key: "golden-rejected-001", text: "虚构账单要求立即转账，拒绝该建议。" };
  const rejectedCreated = await call(app, log, "rejected", "model_proposal", "/api/review", rejectedInput, 200);
  const rejectedHandoff = await call(app, log, "rejected", "risk_handoff_read", "/api/review/task/" + encodeURIComponent(rejectedCreated.task_id) + "/risk-handoff", undefined, 200);
  const rejected = await call(app, log, "rejected", "risk_rejected", "/api/review/risk-callback", {
    callback_version: "risk-callback.v1", handoff_id: rejectedHandoff.handoff_id,
    task_id: rejectedHandoff.task_id, request_id: rejectedHandoff.request_id, run_id: rejectedHandoff.run_id,
    audit_id: rejectedHandoff.audit_id, proposal_sha256: rejectedHandoff.proposal.proposal_sha256,
    decision: "REJECT", reviewer: "synthetic-risk-owner", reason: "虚构证据无法证明收款账户变更合法。"
  }, 200);
  assert.equal(rejected.callback_status, "RECORDED");
  assert.equal(rejected.workflow.status, "REJECTED");
  assert.equal(rejected.workflow.execution.execution_allowed, false);
  const rejectedExecution = await call(app, log, "rejected", "execution_blocked_after_reject", "/api/review/simulate", {
    task_id: rejectedCreated.task_id, proposal_sha256: rejectedCreated.proposed_action.proposal_sha256
  }, 409);
  assert.equal(rejectedExecution.error.code, "EXECUTION_BLOCKED");

  const result = {
    evidence_version: "core-agent-golden-path.v1",
    recorded_at: new Date().toISOString(),
    mode: "LOCAL_SYNTHETIC",
    status: "PASS",
    external_model_calls: 0,
    paid_model_calls: 0,
    formal_risk_service_called: false,
    formal_approval_identity_used: false,
    real_execution_gateway_called: false,
    approved_flow: {
      trace: trace(finalApproved),
      model: { source: finalApproved.model.source, call_succeeded: finalApproved.model.model_response.call_succeeded, provider_response_id: finalApproved.model.model_response.provider_response_id },
      states: ["PENDING_RISK", "PENDING_APPROVAL", "READY_FOR_SIMULATION", "SIMULATED"],
      execution: { status: finalApproved.execution.status, execution_allowed: finalApproved.execution.execution_allowed, side_effects: finalApproved.execution.receipt.side_effects, execution_id: finalApproved.execution.execution_id },
      audit_event_types: eventTypes(finalApproved)
    },
    rejected_flow: {
      trace: trace(rejected.workflow),
      states: ["PENDING_RISK", "REJECTED"],
      execution_blocked_after_reject: rejectedExecution.error.code === "EXECUTION_BLOCKED",
      audit_event_types: eventTypes(rejected.workflow)
    },
    assertions: {
      same_task_bound_across_handoff_risk_approval_execution: true,
      execution_blocked_before_risk: true,
      execution_blocked_after_risk_rejection: true,
      paper_receipt_has_no_side_effects: true,
      replay_kept_same_audit_and_execution_receipt: true
    },
    runtime_log: "logs/core-agent-golden-path-2026-10-19.jsonl"
  };

  if (writeArtifacts) {
    const docs = path.join(root, "docs");
    const logs = path.join(root, "logs");
    fs.mkdirSync(docs, { recursive: true });
    fs.mkdirSync(logs, { recursive: true });
    fs.writeFileSync(path.join(docs, "core-agent-golden-path-tests-2026-10-19.json"), JSON.stringify(result, null, 2) + "\n");
    fs.writeFileSync(path.join(logs, "core-agent-golden-path-2026-10-19.jsonl"), log.map(item => JSON.stringify(item)).join("\n") + "\n");
  }
  return { result, log };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { result, log } = await runGoldenPath();
  process.stdout.write(JSON.stringify({ status: result.status, steps: log.length, approved: result.approved_flow.trace, rejected: result.rejected_flow.trace, paid_model_calls: result.paid_model_calls }) + "\n");
}

