"use strict";

const { createHash } = require("node:crypto");

const ADAPTER_VERSION = "risk-core-callback-adapter.v1";
const CALLBACK_FIELDS = ["callback_version", "handoff_id", "task_id", "request_id", "run_id", "audit_id", "proposal_sha256", "decision", "reviewer", "reason"];
const BINDING_FIELDS = ["handoff_id", "task_id", "request_id", "run_id", "audit_id", "proposal_sha256"];
const RESULT_FIELDS = ["risk_check_id", "decision", "check_complete", "checked_at", "policy_version", "core_binding", "local_task_id", "reasons"];
const HANDOFF_REQUIRED_FIELDS = Object.freeze(["handoff_version", "contract_version", "workflow_version", "schema_version", "handoff_id", "task_id", "request_id", "session_id", "run_id", "audit_id", "data_mode", "execution_mode", "capability", "plan_id", "plan_hash", "policy_version", "owner", "record_endpoint", "workflow_status", "status", "decision", "execution_allowed", "proposal", "reviewed_input", "input_authority", "model", "evidence", "approval", "audit", "memory_write_status", "trace", "callback"]);
const HANDOFF_ALLOWED_FIELDS = Object.freeze(["funding_check", "cancellation", "reviewed_input", "input_authority", "handoff_version", "contract_version", "workflow_version", "schema_version", "handoff_id", "task_id", "request_id", "session_id", "run_id", "audit_id", "data_mode", "execution_mode", "capability", "scenario", "output_contract", "portfolio_snapshot_id", "risk_profile_version", "plan_id", "plan_hash", "policy_version", "owner", "record_endpoint", "workflow_status", "status", "decision", "execution_allowed", "proposal", "model", "evidence", "approval", "risk_dispatch", "memory_write_status", "trace", "audit", "callback"]);
const MAPPING = Object.freeze({ ALLOW: "APPROVE", REVIEW: "REQUEST_MORE_INFO", BLOCK: "REJECT" });
const PRIORITY = ["ERROR", "BLOCK", "REVIEW"];
const DIGEST = /^[a-f0-9]{64}$/;
const TOKEN = /^[A-Z][A-Z0-9_]{0,99}$/;
const RULE = /^[A-Z][A-Z0-9_-]{0,49}$/;
const object = value => value !== null && typeof value === "object" && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));

class CallbackAdapterError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CallbackAdapterError";
    this.code = code;
    this.stage = "RISK_CALLBACK_ADAPTER";
    this.execution_allowed = false;
    this.dispatch_allowed = false;
  }
}

function fail(code, message) { throw new CallbackAdapterError(code, message); }
function requireObject(value, label) { if (!object(value)) fail("INVALID_ADAPTER_INPUT", `${label} must be a plain object.`); }
function exactFields(value, fields, label) {
  requireObject(value, label);
  if (Object.keys(value).length !== fields.length || fields.some(field => !Object.hasOwn(value, field)) || Object.keys(value).some(field => !fields.includes(field))) fail("UNTRUSTED_CONTROL_FIELD", `${label} must contain exactly the documented fields.`);
}
function text(value, label, max = 500) {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.length > max) fail("INVALID_ADAPTER_INPUT", `${label} must be a non-empty, unpadded string of at most ${max} characters.`);
  return value;
}
function digest(value, label) { if (typeof value !== "string" || !DIGEST.test(value)) fail("INVALID_PROPOSAL_HASH", `${label} must be a lowercase SHA256 digest.`); return value; }
function equal(actual, expected, label) { if (actual !== expected) fail("RISK_HANDOFF_MISMATCH", `${label} does not match the reviewed Core handoff.`); }
function nullableText(value, label) { return value === null ? null : text(value, label); }
function validDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) return false;
  const day = value.slice(0, 10);
  return new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) === day;
}
function assertJson(value, seen = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (!(Array.isArray(value) || object(value)) || seen.has(value)) fail("INVALID_PROPOSAL", "Proposal must contain finite JSON values without cycles.");
  seen.add(value);
  for (const item of Array.isArray(value) ? value : Object.values(value)) assertJson(item, seen);
  seen.delete(value);
}

// This validator checks a stored handoff snapshot; it does not authenticate its sender.
function extractCoreBinding(handoff) {
  requireObject(handoff, "handoff");
  if (Object.keys(handoff).some(field => !HANDOFF_ALLOWED_FIELDS.includes(field))) fail("UNEXPECTED_HANDOFF_FIELD", "Core's frozen handoff contract does not allow extra top-level fields.");
  if (HANDOFF_REQUIRED_FIELDS.some(field => !Object.hasOwn(handoff, field) || handoff[field] === undefined)) fail("INCOMPLETE_HANDOFF", "Core handoff is missing a required top-level field.");
  if (handoff.handoff_version !== "risk-handoff.v1" || handoff.contract_version !== "model-review.v1" || handoff.workflow_version !== "review-workflow.v1" || handoff.schema_version !== "model-review.v1") fail("UNSUPPORTED_HANDOFF_VERSION", "Use the current Core handoff contract.");
  if (handoff.workflow_status !== "PENDING_RISK" || handoff.status !== "PENDING_REVIEW" || handoff.decision !== "REQUIRED" || handoff.execution_allowed !== false || handoff.execution_mode !== "PAPER") fail("HANDOFF_NOT_PENDING", "Only a pending, non-executing PAPER handoff can be drafted.");
  if (!["REVIEW_ONLY", "SIMULATION_ONLY"].includes(handoff.capability)) fail("UNSUPPORTED_CAPABILITY", "This adapter cannot grant a real-money capability.");
  if (handoff.input_authority !== "UNVERIFIED_CALLER_INPUT") fail("UNTRUSTED_AUTHORITY_CLAIM", "Caller business data cannot claim system or verified account authority.");
  requireObject(handoff.proposal, "handoff.proposal");
  const proposalHash = digest(handoff.proposal.proposal_sha256, "proposal.proposal_sha256");
  assertJson(handoff.proposal);
  const unhashed = { ...handoff.proposal }; delete unhashed.proposal_sha256;
  // Match Core hash(proposal): original JSON insertion order, not sorted request fingerprints.
  const calculated = createHash("sha256").update(JSON.stringify(unhashed), "utf8").digest("hex");
  if (calculated !== proposalHash) fail("PROPOSAL_CONTENT_CHANGED", "The full proposal no longer matches its original Core digest.");
  const binding = Object.fromEntries(BINDING_FIELDS.map(field => [field, field === "proposal_sha256" ? proposalHash : text(handoff[field], `handoff.${field}`)]));
  requireObject(handoff.evidence, "handoff.evidence");
  equal(handoff.evidence.proposal_sha256, proposalHash, "evidence.proposal_sha256");
  equal(handoff.evidence.audit_id, binding.audit_id, "evidence.audit_id");
  for (const value of [handoff.plan_hash, handoff.evidence.plan_hash]) if (value != null) equal(digest(value, "plan_hash"), proposalHash, "plan_hash");
  if (handoff.plan_id != null && handoff.evidence.plan_id != null) equal(handoff.evidence.plan_id, handoff.plan_id, "evidence.plan_id");
  requireObject(handoff.trace, "handoff.trace");
  equal(handoff.trace.schema_version, handoff.schema_version, "trace.schema_version");
  for (const field of BINDING_FIELDS.filter(field => field !== "proposal_sha256")) equal(handoff.trace[field], binding[field], `trace.${field}`);
  nullableText(handoff.session_id, "handoff.session_id"); equal(handoff.trace.session_id, handoff.session_id, "trace.session_id");
  requireObject(handoff.audit, "handoff.audit"); equal(handoff.audit.audit_id, binding.audit_id, "audit.audit_id");
  requireObject(handoff.model, "handoff.model");
  if (handoff.model.source !== "model" || handoff.model.call_succeeded !== true || handoff.model.status !== "PROPOSED") fail("MODEL_EVIDENCE_REQUIRED", "A rules fallback or failed model cannot be labelled a successful model handoff.");
  const providerId = nullableText(handoff.model.provider_response_id, "model.provider_response_id");
  equal(handoff.evidence.model_response_id, providerId, "evidence.model_response_id");
  equal(handoff.proposal.model_response_id, providerId, "proposal.model_response_id");
  requireObject(handoff.approval, "handoff.approval");
  if (!["BLOCKED", "PENDING", "NOT_REQUIRED"].includes(handoff.approval.status) || handoff.approval.decision !== null || handoff.approval.approver !== null || handoff.approval.decided_at !== null || typeof handoff.approval.required !== "boolean") fail("PREAPPROVED_HANDOFF", "Risk drafting must not inherit an already approved, denied, or fabricated human approval.");
  equal(handoff.approval.task_id, binding.task_id, "approval.task_id");
  equal(handoff.approval.proposal_sha256, proposalHash, "approval.proposal_sha256");
  requireObject(handoff.callback, "handoff.callback");
  if (handoff.callback.callback_version !== "risk-callback.v1" || handoff.callback.method !== "POST" || handoff.callback.endpoint !== "/api/review/risk-callback" || !Array.isArray(handoff.callback.required_fields) || handoff.callback.required_fields.length !== CALLBACK_FIELDS.length || new Set(handoff.callback.required_fields).size !== CALLBACK_FIELDS.length || CALLBACK_FIELDS.some(field => !handoff.callback.required_fields.includes(field))) fail("UNSUPPORTED_CALLBACK_CONTRACT", "Use the frozen Core callback fields and relative endpoint.");
  return structuredClone(binding);
}

function validateResult(result, handoff, binding) {
  exactFields(result, RESULT_FIELDS, "risk_result");
  text(result.risk_check_id, "risk_check_id"); text(result.local_task_id, "local_task_id"); text(result.policy_version, "policy_version");
  if (!["ALLOW", "REVIEW", "BLOCK", "ERROR"].includes(result.decision)) fail("INVALID_RISK_RESULT", "Risk must return one of the four registered decisions.");
  if (result.check_complete !== (result.decision !== "ERROR")) fail("INCOMPLETE_RISK_CHECK", "An incomplete or failed check cannot become a business approval.");
  if (!validDate(result.checked_at)) fail("INVALID_RISK_TIMESTAMP", "checked_at must be a complete valid ISO timestamp with timezone.");
  exactFields(result.core_binding, BINDING_FIELDS, "risk_result.core_binding");
  for (const field of BINDING_FIELDS) equal(result.core_binding[field], binding[field], `risk_result.core_binding.${field}`);
  for (const value of [handoff.policy_version, handoff.evidence.policy_version]) if (value != null) equal(result.policy_version, text(value, "handoff policy_version"), "policy_version");
  if (!Array.isArray(result.reasons) || result.reasons.length > 100) fail("INVALID_RISK_RESULT", "reasons must contain at most 100 registered reason records.");
  for (const row of result.reasons) {
    exactFields(row, ["rule_id", "code", "message_zh", "status"], "risk reason");
    if (typeof row.rule_id !== "string" || typeof row.code !== "string" || !RULE.test(row.rule_id) || !TOKEN.test(row.code)) fail("INVALID_REASON_CODE", "Reason rule and code must be stable machine identifiers.");
    text(row.message_zh, "reason.message_zh", 2000);
    if (!PRIORITY.includes(row.status)) fail("INVALID_REASON_STATUS", "Risk reasons must use REVIEW, BLOCK or ERROR; keep warnings separate.");
  }
  const expected = PRIORITY.find(status => result.reasons.some(row => row.status === status)) || "ALLOW";
  if (result.decision !== expected) fail("RISK_RESULT_INCONSISTENT", "Decision must preserve ERROR > BLOCK > REVIEW > ALLOW across all reasons.");
}

function buildRiskCallbackDraft(input) {
  exactFields(input, ["handoff", "risk_result", "reviewer"], "adapter request");
  const { handoff, risk_result: result } = input, reviewer = text(input.reviewer, "reviewer");
  const binding = extractCoreBinding(handoff);
  validateResult(result, handoff, binding);
  const auditContext = { risk_check_id: result.risk_check_id, checked_at: result.checked_at, policy_version: result.policy_version,
    local_task_id: result.local_task_id, core_binding: binding, plan_hash: handoff.plan_hash ?? null,
    reason_codes: result.reasons.map(row => row.code), reasons: structuredClone(result.reasons) };
  let callback = null;
  if (result.decision !== "ERROR") {
    const labels = { ALLOW: "风险检查通过，未授予执行权", REVIEW: "需要补充资料或重新复核，执行暂停", BLOCK: "风险检查阻止此方案" };
    const codes = [...new Set(result.reasons.map(row => row.code))].join(",") || "NONE";
    const reason = `${labels[result.decision]}；检查=${result.risk_check_id}；原因=${codes}`;
    if (reason.length > 500) fail("CALLBACK_REASON_TOO_LONG", "Callback reason exceeds 500 characters; keep complete details in Risk audit and use a shorter registered summary.");
    callback = { callback_version: "risk-callback.v1", ...binding, decision: MAPPING[result.decision], reviewer, reason };
  }
  const actions = result.decision === "ERROR"
    ? ["PERSIST_RISK_ERROR_AND_KEEP_EXECUTION_CLOSED", "RESTORE_REQUIRED_CHECKS_BEFORE_DRAFTING_CALLBACK"]
    : ["LOAD_SERVER_OWNED_TASK_AND_VERIFY_CURRENT_VERSIONS", "VERIFY_SENDER_IDENTITY_AND_APPLY_CORE_SIGNATURE_CONTRACT", "PERSIST_RISK_AUDIT_BEFORE_DISPATCH", "APPLY_CORE_APPROVAL_AND_EXECUTION_GATES"];
  if (result.decision === "REVIEW") actions.push("AFTER_ACCEPTED_REQUEST_MORE_INFO_CREATE_NEW_CORE_TASK_AND_HANDOFF");
  return { adapter_version: ADAPTER_VERSION, risk_decision: result.decision, status: callback ? "DRAFT_READY" : "ERROR_HELD",
    dispatch_allowed: false, execution_allowed: false, callback, audit_context: auditContext, required_next_actions: actions };
}

module.exports = { CallbackAdapterError, ADAPTER_VERSION, buildRiskCallbackDraft, extractCoreBinding, HANDOFF_REQUIRED_FIELDS, HANDOFF_ALLOWED_FIELDS };
