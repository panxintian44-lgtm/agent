"use strict";
// A validated deterministic projection; never an authority for execution.
const policy = require("../../../docs/safety-risk-eval/unified-rating-v1/risk-policy.json");
const registry = require("../../../docs/safety-risk-eval/daily-policy-v1/policy-config.v1.json");
const runtime = require("./runtime-config.v1.1.json");
const dependencies = require("./dependency-map.v1.1.json");
const { validateDailyResult, plain, softCodes } = require("./daily-result-validation.cjs");
const financialHard = new Set(dependencies.financial_hard_codes);
const control = new Set(registry.rules.find(rule => rule.rule_id === "D08").reasons.map(row => row.code));
const labels = Object.fromEntries(policy.business_bands.map(row => [row.code, row.label]));
const number = value => Number.isSafeInteger(value);
function optionalData(row) {
  return row.rule_id === "D01" && typeof row.field === "string" && (dependencies.optional_data_fields.includes(row.field) || dependencies.optional_field_prefixes.some(prefix => row.field.startsWith(prefix)));
}
function projectAssessment(result, options = {}) {
  let safe, safeOptions;
  try { safe = plain(result) ? result : null; safeOptions = plain(options) ? options : null; } catch { safe = null; safeOptions = null; }
  const target = typeof safeOptions?.target === "string" ? safeOptions.target : "DAILY_CASHFLOW";
  const validDecision = value => ["ALLOW", "REVIEW", "BLOCK", "ERROR"].includes(value);
  const base = {
    assessment_version: runtime.assessment_version, policy_version: runtime.risk_policy_version,
    source_policy_version: typeof safe?.policy_version === "string" ? safe.policy_version : null, target,
    source_risk_check_id: typeof safe?.risk_check_id === "string" ? safe.risk_check_id : null,
    business_risk_band: "UNKNOWN", label_zh: labels.UNKNOWN, coverage: "UNAVAILABLE",
    risk_decision: validDecision(safe?.decision) ? safe.decision : null,
    engine_ran: false, execution_allowed: false, reason_codes: [], control_reason_codes: [], scenario_reason_codes: [],
    validation_status: "INVALID", validation_errors: [], unknown_items: [],
    scope: "用户确认的虚构单资金池；不含真实账户、组合适当性或未来收益评级。",
    institutional_rating: "NOT_ASSESSED", safety_guarantee: false,
    limitations: ["评级不构成审批或执行授权。", "保留原引擎 ERROR 优先级及已签署回调，不以评级改写历史结论。"]
  };
  if (target !== "DAILY_CASHFLOW") return { ...base, validation_status: "UNSUPPORTED", validation_errors: [{ code: "ASSESSMENT_TARGET_UNSUPPORTED", message_zh: "该评估目标尚未接入经过验证的评级适配器。", path: "target" }] };
  const validation = validateDailyResult(result);
  base.engine_ran = Boolean(safe && safe.contract_version === runtime.supported_source_contract && safe.policy_version === runtime.supported_source_policy);
  if (validation.validation_status !== "VALID") return { ...base, ...validation, limitations: [...base.limitations, "结果校验未通过，当前原始判定不能用于模型请求、正式回调或执行。"] };
  const rows = [result.reasons, result.warnings, result.info, result.gate_reasons].flat();
  base.reason_codes = [...new Set(rows.map(row => row.code))];
  base.control_reason_codes = base.reason_codes.filter(code => control.has(code));
  base.scenario_reason_codes = base.reason_codes.filter(code => code === "CASHFLOW_STRESS_GAP");
  base.unknown_items = result.reasons.filter(row => row.status === "ERROR" || row.status === "REVIEW" && !(softCodes.has(row.code) && row.acceptance_allowed === true)).map(row => ({
    rule_id: row.rule_id, code: row.code, field: row.field ?? null,
    dependency_scope: optionalData(row) ? "OPTIONAL_INDICATOR" : dependencies.core_evidence_rules.includes(row.rule_id) || dependencies.core_evidence_review_codes.includes(row.code) ? "CORE_CASH_EVIDENCE" : "CONTROL_OR_OTHER_EVIDENCE",
    message_zh: row.message_zh, recovery: row.recovery.message_zh
  }));
  const metricsComplete = ["free_before_minor", "projected_free_after_minor", "shortfall_minor"].every(key => number(result.metrics[key]));
  const complete = metricsComplete && base.unknown_items.length === 0 && result.check_complete === true && !result.checks.some(row => ["ERROR", "NOT_EVALUATED"].includes(row.status));
  const coreUnknown = base.unknown_items.some(row => row.dependency_scope === "CORE_CASH_EVIDENCE");
  const hard = rows.some(row => financialHard.has(row.code) && row.status === "BLOCK");
  let band = "UNKNOWN";
  if (hard && metricsComplete && !coreUnknown) band = "HIGH";
  else if (complete) {
    if (rows.some(row => softCodes.has(row.code) && row.status === "REVIEW" && row.acceptance_allowed === true)) band = "ELEVATED";
    else if (rows.some(row => softCodes.has(row.code) && row.status === "WARNING")) band = "NOTICE";
    else if (result.decision !== "ERROR") band = "LOW";
  }
  return { ...base, ...validation, business_risk_band: band, label_zh: labels[band], coverage: complete ? "FULL" : "PARTIAL" };
}
function deriveAssessment(result, options = {}) {
  try { return projectAssessment(result, options); }
  catch { return { ...projectAssessment(null), validation_errors: [{ code: "RESULT_VALIDATION_FAILED", message_zh: "结果核验未能完成，不能采用该结果。", path: "result" }] }; }
}
module.exports = { deriveAssessment, validateDailyResult };
