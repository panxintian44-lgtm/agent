"use strict";

const { evaluateDaily } = require("../daily-engine.cjs");
const { minorToYuan } = require("./money.cjs");
const { deriveAssessment } = require("../unified-rating/assessment.cjs");

const CONTRACT_VERSION = "conversation-finance.v1";
const NOTICE = "仅分析用户确认的虚构资金池；共享资金占用、真实账户、审批和执行网关尚未可信接通。本结果不授予执行权限。";
const ACTION_TYPES = Object.freeze({ INVESTMENT: "OPTIONAL_INVESTMENT", CONSUMPTION: "OPTIONAL_PAYMENT", SUBSCRIPTION_PAYMENT: "SUBSCRIPTION_PAYMENT", PURPOSE_PAYMENT: "PURPOSE_PAYMENT" });

class ConversationRiskError extends Error {
  constructor(code, message, field) {
    super(message);
    this.name = "ConversationRiskError";
    this.code = code;
    this.field = field;
  }
}

function invalid(field, message = "Unsupported or invalid conversation finance field.") {
  throw new ConversationRiskError("INVALID_CONVERSATION_FINANCE", message, field);
}

function record(value, allowed, field) {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid(field);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.includes(key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), "value")) invalid(`${field}.${String(key)}`, "Control fields and unknown fields are not accepted as financial facts.");
  }
  return value;
}

function amount(value, field) {
  if (value === undefined || value === null) return null;
  try { minorToYuan(value); }
  catch (error) { throw new ConversationRiskError(error.code, error.message, field); }
  return Object.is(value, -0) ? 0 : value;
}

function text(value, field, maximum, nullable = true) {
  if (nullable && (value === undefined || value === null)) return null;
  if (typeof value !== "string" || value.length > maximum || !value.trim()) invalid(field);
  return value;
}

function flag(value, field) {
  if (value === undefined) return false;
  if (typeof value !== "boolean") invalid(field);
  return value;
}

function id(value, field) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.:-]{1,180}$/.test(value)) invalid(field);
  return value;
}

function optionalDate(value, field) {
  // The deterministic engine checks calendar validity and date ordering.
  return text(value, field, 40);
}

function rows(value, field, maximum, parse) {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.length > maximum) invalid(field);
  return value.map((row, index) => parse(row, `${field}[${index}]`));
}

function parseFinance(input) {
  if (input === undefined || input === null) return null;
  const source = record(input, ["contract_version", "data_mode", "snapshot", "action", "facts_confirmed", "purposes_confirmed", "existing_holds_minor", "budget", "emergency", "note"], "dailyFinance");
  if (source.contract_version !== CONTRACT_VERSION) invalid("dailyFinance.contract_version", `Expected ${CONTRACT_VERSION}.`);
  if (source.data_mode !== "SYNTHETIC_REPLAY") invalid("dailyFinance.data_mode", "Only an explicitly synthetic replay is supported.");
  const snapshot = source.snapshot == null ? {} : record(source.snapshot, ["currency", "cash_ledger_minor", "as_of", "purposes", "hard_floor", "income_events"], "snapshot");
  if (snapshot.currency !== undefined && snapshot.currency !== null && snapshot.currency !== "CNY") invalid("snapshot.currency", "Only CNY is supported.");
  const purposes = rows(snapshot.purposes, "snapshot.purposes", 20, (row, field) => {
    record(row, ["purpose_id", "label", "reserved_now_minor", "remaining_due_minor", "due_at"], field);
    return { purpose_id: id(row.purpose_id, `${field}.purpose_id`), label: text(row.label, `${field}.label`, 120), reserved_now_minor: amount(row.reserved_now_minor, `${field}.reserved_now_minor`), remaining_due_minor: amount(row.remaining_due_minor, `${field}.remaining_due_minor`), due_at: optionalDate(row.due_at, `${field}.due_at`) };
  });
  const incomes = rows(snapshot.income_events, "snapshot.income_events", 40, (row, field) => {
    record(row, ["event_id", "label", "amount_minor", "status", "at", "included_in_balance"], field);
    if (row.status != null && !["RECEIVED", "EXPECTED"].includes(row.status)) invalid(`${field}.status`);
    const included = row.included_in_balance == null ? null : flag(row.included_in_balance, `${field}.included_in_balance`);
    if (row.status === "EXPECTED" && included === true) invalid(`${field}.included_in_balance`, "Expected income cannot already be included in the balance.");
    return { event_id: id(row.event_id, `${field}.event_id`), label: text(row.label, `${field}.label`, 120), amount_minor: amount(row.amount_minor, `${field}.amount_minor`), status: row.status || null, at: optionalDate(row.at, `${field}.at`), included_in_balance: included };
  });
  const floor = snapshot.hard_floor == null ? {} : record(snapshot.hard_floor, ["state", "amount_minor", "covered_by_purpose_id"], "snapshot.hard_floor");
  if (floor.state != null && !["ENABLED_CONFIRMED", "DISABLED_CONFIRMED", "UNKNOWN", "UNSPECIFIED"].includes(floor.state)) invalid("snapshot.hard_floor.state");
  const floorPurpose = floor.covered_by_purpose_id == null ? null : id(floor.covered_by_purpose_id, "snapshot.hard_floor.covered_by_purpose_id");
  if (floorPurpose && !purposes?.some(row => row.purpose_id === floorPurpose)) invalid("snapshot.hard_floor.covered_by_purpose_id");
  const action = source.action == null ? {} : record(source.action, ["type", "amount_minor", "fees_minor", "at", "matched_purpose_id", "depends_on_redemption", "latest_reliable_available_at"], "action");
  if (action.type != null && !Object.hasOwn(ACTION_TYPES, action.type)) invalid("action.type", "This conversation adapter does not accept execution tools or real trading.");
  const budget = source.budget == null ? {} : record(source.budget, ["enabled", "period_take_home_minor", "needs_minor", "goals_minor", "wants_minor", "category_remaining_minor", "require_acceptance"], "budget");
  const emergency = source.emergency == null ? {} : record(source.emergency, ["enabled", "allocation_minor", "monthly_essential_minor", "target_months", "require_acceptance"], "emergency");
  if (emergency.target_months != null && (typeof emergency.target_months !== "number" || !Number.isFinite(emergency.target_months) || emergency.target_months < 0 || emergency.target_months > 120)) invalid("emergency.target_months");
  return {
    facts_confirmed: flag(source.facts_confirmed, "facts_confirmed"), purposes_confirmed: flag(source.purposes_confirmed, "purposes_confirmed"),
    snapshot: { currency: snapshot.currency || null, cash_ledger_minor: amount(snapshot.cash_ledger_minor, "snapshot.cash_ledger_minor"), as_of: optionalDate(snapshot.as_of, "snapshot.as_of"), purposes, income_events: incomes, hard_floor: { state: floor.state || "UNKNOWN", amount_minor: amount(floor.amount_minor, "snapshot.hard_floor.amount_minor"), covered_by_purpose_id: floorPurpose } },
    existing_holds_minor: amount(source.existing_holds_minor, "existing_holds_minor"),
    action: { type: action.type || null, amount_minor: amount(action.amount_minor, "action.amount_minor"), fees_minor: amount(action.fees_minor, "action.fees_minor"), at: optionalDate(action.at, "action.at"), matched_purpose_id: action.matched_purpose_id == null ? null : id(action.matched_purpose_id, "action.matched_purpose_id"), depends_on_redemption: flag(action.depends_on_redemption, "action.depends_on_redemption"), latest_reliable_available_at: optionalDate(action.latest_reliable_available_at, "action.latest_reliable_available_at") },
    budget: { enabled: flag(budget.enabled, "budget.enabled"), period_take_home_minor: amount(budget.period_take_home_minor, "budget.period_take_home_minor"), needs_minor: amount(budget.needs_minor, "budget.needs_minor"), goals_minor: amount(budget.goals_minor, "budget.goals_minor"), wants_minor: amount(budget.wants_minor, "budget.wants_minor"), category_remaining_minor: amount(budget.category_remaining_minor, "budget.category_remaining_minor"), require_acceptance: flag(budget.require_acceptance, "budget.require_acceptance") },
    emergency: { enabled: flag(emergency.enabled, "emergency.enabled"), allocation_minor: amount(emergency.allocation_minor, "emergency.allocation_minor"), monthly_essential_minor: amount(emergency.monthly_essential_minor, "emergency.monthly_essential_minor"), target_months: emergency.target_months ?? null, require_acceptance: flag(emergency.require_acceptance, "emergency.require_acceptance") },
    note: text(source.note, "note", 4000)
  };
}

function normalizedFacts(finance, question) {
  const factsConfirmed = finance?.facts_confirmed === true;
  const purposesConfirmed = finance?.purposes_confirmed === true && Array.isArray(finance?.snapshot.purposes);
  const snapshot = finance?.snapshot;
  const action = finance?.action;
  const cash = factsConfirmed && snapshot?.currency === "CNY" ? snapshot.cash_ledger_minor : null;
  const held = factsConfirmed ? finance?.existing_holds_minor ?? null : null;
  const purposes = (snapshot?.purposes || []).map(row => ({ ...row, reserved_now_minor: purposesConfirmed ? row.reserved_now_minor : null, remaining_due_minor: purposesConfirmed ? row.remaining_due_minor : null, confirmed: purposesConfirmed }));
  const incomes = (snapshot?.income_events || []).map(row => ({ ...row, amount_minor: factsConfirmed ? row.amount_minor : null }));
  const evidenceComplete = factsConfirmed && purposesConfirmed && snapshot?.currency === "CNY" && Array.isArray(snapshot.income_events) && held !== null && incomes.every(row => row.included_in_balance !== null && row.status !== null);
  const floor = snapshot?.hard_floor;
  const budget = finance?.budget;
  const emergency = finance?.emergency;
  const softConfirmation = Boolean(budget?.enabled && budget.require_acceptance || emergency?.enabled && emergency.require_acceptance);
  const facts = {
    currency: "CNY", amount_unit: "MINOR", scope: "ANALYSIS",
    cash_ledger_minor: cash, cash_available_minor: cash !== null && held !== null ? cash - held : null,
    holds: held === null || held === 0 ? [] : [{ hold_id: "declared-synthetic-hold", amount_minor: held, covered_reserved_minor: 0, purpose_id: null, settlement_link: "USER_DECLARED_SYNTHETIC", status: "ACTIVE" }],
    purposes, income_events: incomes, as_of: factsConfirmed ? snapshot?.as_of ?? null : null,
    hard_floor_state: factsConfirmed ? floor?.state || "UNKNOWN" : "UNKNOWN", configured_hard_floor_minor: factsConfirmed ? floor?.amount_minor ?? null : null,
    hard_floor_covered_by_purpose: purposesConfirmed ? floor?.covered_by_purpose_id ?? null : null,
    action_type: ACTION_TYPES[action?.type] || "UNKNOWN", action_amount_minor: action?.amount_minor ?? null, fees_minor: action?.fees_minor ?? null,
    extra_nonoverlapping_hold_minor: 0, action_at: action?.at ?? null, matched_purpose_id: action?.matched_purpose_id ?? null,
    purpose_link: "USER_REPORTED_SYNTHETIC_UNVERIFIED", ledger_revision: 0, versions_current: true,
    approval_state: "PENDING", required_evidence: evidenceComplete ? "USER_CONFIRMED_SYNTHETIC" : "USER_CONFIRMATION_OR_DATA_REQUIRED",
    required_services: "AVAILABLE", gateway_connected: false, audit_intent_writable: false, idempotency_state: "NEW",
    proposed_tool: "PAPER_ANALYSIS", external_note: [question, finance?.note].filter(Boolean).join("\n"),
    soft_goal_acceptance_required: softConfirmation, soft_goal_acceptance_state: softConfirmation ? "PENDING" : "NOT_REQUIRED",
    budget_reference_enabled: budget?.enabled === true && ([budget.period_take_home_minor, budget.needs_minor, budget.goals_minor, budget.wants_minor].some(value => value !== null) || budget.category_remaining_minor === null),
    period_take_home_minor: factsConfirmed ? budget?.period_take_home_minor ?? null : null,
    budget_buckets_minor: { needs: factsConfirmed ? budget?.needs_minor ?? null : null, goals: factsConfirmed ? budget?.goals_minor ?? null : null, wants: factsConfirmed ? budget?.wants_minor ?? null : null },
    emergency_target_enabled: emergency?.enabled === true, emergency_within_free_cash: true,
    emergency_allocation_before_minor: factsConfirmed ? emergency?.allocation_minor ?? null : null,
    action_uses_emergency_allocation_minor: 0, monthly_essential_minor: factsConfirmed ? emergency?.monthly_essential_minor ?? null : null, target_months: emergency?.target_months ?? null,
    plan_depends_on_redeeming_other_asset: action?.depends_on_redemption === true,
    latest_reliable_available_at: action?.latest_reliable_available_at ?? null, redemption_evidence: null
  };
  if (budget?.enabled && ["CONSUMPTION", "SUBSCRIPTION_PAYMENT"].includes(action?.type)) facts.category_budget_remaining_minor = factsConfirmed ? budget.category_remaining_minor : null;
  return facts;
}

function displayAmount(value) {
  return minorToYuan(value ?? null, { allowNegative: true, maxMinor: Number.MAX_SAFE_INTEGER });
}

function assessConversation(input) {
  record(input, ["question", "dailyFinance", "now", "checkId"], "input");
  const question = text(input.question, "question", 20000) || "";
  if (input.now !== undefined && (typeof input.now !== "string" || !Number.isFinite(Date.parse(input.now)))) invalid("now");
  if (input.checkId !== undefined) id(input.checkId, "checkId");
  const finance = parseFinance(input.dailyFinance);
  const facts = normalizedFacts(finance, question);
  const result = evaluateDaily(facts, { now: input.now, checkId: input.checkId });
  const unifiedAssessment = deriveAssessment(result);
  const metrics = { ...result.metrics };
  for (const name of ["free_before_minor", "available_for_new_action_minor", "protected_before_minor", "holds_before_minor", "projected_independent_floor_minor", "projected_free_after_minor", "shortfall_minor", "action_total_minor", "after_action_date_gap_minor", "budget_over_minor", "emergency_allocation_after_minor"]) metrics[name.replace(/_minor$/, "_yuan")] = displayAmount(result.metrics[name]);
  const canSize = ["INVESTMENT", "CONSUMPTION", "SUBSCRIPTION_PAYMENT"].includes(finance?.action.type) && Number.isSafeInteger(result.metrics.available_for_new_action_minor) && Number.isSafeInteger(finance?.action.fees_minor);
  metrics.suggested_max_principal_minor = canSize ? Math.max(0, result.metrics.available_for_new_action_minor - finance.action.fees_minor) : null;
  metrics.suggested_max_principal_yuan = displayAmount(metrics.suggested_max_principal_minor);
  const reasons = result.reasons.map(row => ({ ...row }));
  const nextActions = [...new Set(reasons.map(row => row.recovery.message_zh))];
  if (!finance?.facts_confirmed) nextActions.unshift("请核对并确认结构化余额、已包含的收入、占用、现金保底和费用；问题文字中的数字不会自动成为已确认事实。");
  if (!finance?.purposes_confirmed || !Array.isArray(finance?.snapshot.purposes)) nextActions.unshift("请逐项填写并确认房租、学费、生活费等保护用途；没有用途时请明确确认空列表。");
  if (finance?.existing_holds_minor == null) nextActions.push("请明确这一个虚构资金池已有多少占用；未知占用不能当作零，真实跨任务占用仍需可信账本核验。");
  if (metrics.suggested_max_principal_minor !== null && result.decision === "BLOCK") nextActions.push(`保留已确认保护资金、占用、现金保底及费用后，可先把本次本金缩小到不高于${metrics.suggested_max_principal_yuan}元，再重新评估；还须核对付款日期。`);
  nextActions.push("本入口只提供分析；正式操作仍需同一任务的风控检查、有效完整计划审批及受控网关。");
  const summaries = { ALLOW: "本次安排在已声明、已确认的虚构资金池中通过分析；尚未审批或执行。", REVIEW: "资料或关联仍需补充核对，暂不能判断本次资金安排可行。", BLOCK: "按已确认的虚构资金及保护用途，本次安排会违反资金约束，不能继续相关操作。", ERROR: "数据不一致或检查发生异常，本次评估失败，相关操作保持暂停。" };
  const summary = summaries[result.decision];
  const amountsMessage = result.metrics.free_before_minor == null ? "" : `保留已确认用途${metrics.protected_before_yuan}元、现有占用${metrics.holds_before_yuan}元及独立现金保底${metrics.projected_independent_floor_yuan}元后，当前可用于新增安排${metrics.available_for_new_action_yuan}元。`;
  const shortfallMessage = result.metrics.shortfall_minor > 0 ? `按该计划保护资金将短缺${metrics.shortfall_yuan}元。` : "";
  const salaryMessage = finance?.facts_confirmed && finance.snapshot.income_events?.some(row => row.included_in_balance === true) ? "已含在余额内的工资或其他收入没有重复增加可用资金。" : "";
  const protectedPurposes = (finance?.snapshot.purposes || []).map(row => ({ purpose_id: row.purpose_id, label: row.label, confirmed: finance.purposes_confirmed, reserved_now_minor: finance.purposes_confirmed ? row.reserved_now_minor : null, reserved_now_yuan: displayAmount(finance.purposes_confirmed ? row.reserved_now_minor : null), remaining_due_minor: finance.purposes_confirmed ? row.remaining_due_minor : null, due_at: row.due_at }));
  const confirmedBasis = finance?.facts_confirmed === true && finance?.purposes_confirmed === true && Array.isArray(finance?.snapshot.purposes);
  const advice = { decision: result.decision, summary, metrics, reasons, warnings: result.warnings, next_actions: nextActions, protected_purposes: protectedPurposes, execution_allowed: false, program_generated: true, notice_zh: NOTICE, basis: confirmedBasis ? "USER_CONFIRMED_SINGLE_SYNTHETIC_POOL" : "UNCONFIRMED_SYNTHETIC_INPUT", input_confirmation: { facts_confirmed: finance?.facts_confirmed === true, purposes_confirmed: finance?.purposes_confirmed === true && Array.isArray(finance?.snapshot.purposes), existing_holds_declared: finance?.existing_holds_minor != null }, shared_ledger_verified: false, approval_status: "PENDING", risk_check_id: result.risk_check_id, policy_version: result.policy_version };
  return {
    risk_result: result,
    assistant_message: [`本次生活资金风险：${unifiedAssessment.label_zh}；资料覆盖：${{FULL:"完整",PARTIAL:"部分",UNAVAILABLE:"不可评估"}[unifiedAssessment.coverage]}。`, summary, amountsMessage, shortfallMessage, salaryMessage, reasons.map(row => row.message_zh).join(""), NOTICE].filter(Boolean).join("\n"),
    next_actions: nextActions,
    risk_advice: { ...advice, unified_assessment: unifiedAssessment },
    model_context: { deterministic_risk: { ...advice, unified_assessment: unifiedAssessment, result_authority: "DETERMINISTIC_ANALYSIS_ONLY", financial_facts_from_question: false, external_content_authority: "UNTRUSTED_BUSINESS_DATA", model_may_not_override_decision: true, execution_authorization: "NOT_GRANTED" } },
    action_parameters: { type: finance?.action.type || null, currency: "CNY", unit: "YUAN", amount: displayAmount(finance?.action.amount_minor), fees: displayAmount(finance?.action.fees_minor), scheduled_at: finance?.action.at ?? null, source_unit: "MINOR" }
  };
}

module.exports = { ConversationRiskError, assessConversation, CONTRACT_VERSION };
