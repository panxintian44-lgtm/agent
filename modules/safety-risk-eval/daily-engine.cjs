"use strict";
const { createHash, randomUUID } = require("node:crypto");
const registry = require("../../docs/safety-risk-eval/daily-policy-v1/policy-config.v1.json");
const POLICY_VERSION = registry.policy_version;
const CONTRACT_VERSION = "daily-risk-workbench.v1";
const ACTIONS = new Set(["OPTIONAL_INVESTMENT", "OPTIONAL_PAYMENT", "SUBSCRIPTION_PAYMENT", "PURPOSE_PAYMENT", "SETTLE_EXISTING_HOLD", "ANALYSIS_ONLY"]);
const VALID_SCOPES = new Set(["ANALYSIS", "FUTURE_CONDITIONAL_PLAN", "PAPER_PREFLIGHT"]);
const codebook = new Map(registry.rules.flatMap(rule => rule.reasons.map(reason => [reason.code, { ...reason, rule_id: rule.rule_id }])));
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const money = value => Number.isSafeInteger(value);
const sum = values => values.reduce((total, value) => {
  const next = total + value;
  if (!money(next)) throw new Error("AMOUNT_OVERFLOW");
  return next;
}, 0);
const isoDay = value => typeof value === "string" ? value.slice(0, 10) : null;
const active = hold => !["RELEASED", "SETTLED", "CANCELLED"].includes(hold.status);

function validDate(value) {
  if (typeof value !== "string") return false;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const date = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(value)) return false;
  const day = value.slice(0, 10), test = new Date(`${day}T00:00:00Z`);
  return Number.isFinite(Date.parse(value)) && test.toISOString().slice(0, 10) === day;
}

function describePolicy() {
  return { contract_version: CONTRACT_VERSION, policy_version: POLICY_VERSION, rules: structuredClone(registry.rules),
    amount_unit: "MINOR", currency: "CNY", deterministic: true,
    implementation_scope: "USER_CONFIRMED_SYNTHETIC_DAILY_CASHFLOW", real_transactions_allowed: false,
    unsupported: ["MULTI_CURRENCY", "UNVERIFIED_REAL_ACCOUNTS", "REAL_PAYMENT", "UNVERIFIED_RESERVATION_OVERLAP"],
    invariant: "Risk 通过不授予执行权；可信完整计划确认、版本、幂等、执行前审计及网关均须独立满足。" };
}

// Internal normalized facts only. HTTP adapters must whitelist business fields and
// inject identity, evidence, versions and gate conditions from trusted state.
function evaluateDaily(facts, options = {}) {
  const checkedAt = options.now || new Date().toISOString();
  const checks = registry.rules.map(rule => ({ rule_id: rule.rule_id, title: rule.title, status: "PASS", reason_ids: [], measurements: [] }));
  const reasons = [], warnings = [], info = [], gateReasons = [];
  const metrics = { amount_unit: "MINOR", currency: "CNY", free_before_minor: null, projected_free_after_minor: null, shortfall_minor: null, metric_status: {} };
  let input = facts && typeof facts === "object" && !Array.isArray(facts) ? structuredClone(facts) : {};
  let projectedState = null, gate = "WAITING_APPROVAL", calculationsValid = true;
  const check = id => checks.find(row => row.rule_id === id);
  function add(code, status, message, details = {}, channel = "risk") {
    const definition = codebook.get(code);
    if (!definition) throw new Error(`UNREGISTERED_REASON:${code}`);
    const row = { reason_id: `daily-reason-${digest({ code, details }).slice(0, 20)}`, rule_id: definition.rule_id, code,
      message_zh: message, status, decision: ["ALLOW", "REVIEW", "BLOCK", "ERROR"].includes(status) ? status : null,
      acceptance_allowed: details.acceptance_allowed === true, recovery: { message_zh: definition.recovery },
      evidence_refs: details.evidence_refs || [], ...details };
    const target = channel === "gate" ? gateReasons : status === "WARNING" ? warnings : status === "INFO" ? info : reasons;
    if (!target.some(item => item.reason_id === row.reason_id)) target.push(row);
    check(row.rule_id).reason_ids.push(row.reason_id);
    if (details.measurements) check(row.rule_id).measurements.push(...details.measurements);
    return row;
  }
  function required(value, label) {
    if (value === null || value === undefined || value === "") {
      add("DAILY_DATA_REQUIRED", "REVIEW", `尚未补齐${label}，不能据此取得完整执行资格。`, { field: label });
      calculationsValid = false; return false;
    }
    return true;
  }
  function invalid(label) {
    add("DAILY_DATA_INCONSISTENT", "ERROR", `必要字段${label}的单位、类型或关联不一致。`, { field: label });
    calculationsValid = false;
  }
  function checkAmount(value, label, nonnegative = true) {
    if (!required(value, label)) return false;
    if (!money(value) || (nonnegative && value < 0)) { invalid(label); return false; }
    return true;
  }
  function date(value, label) {
    if (!required(value, label)) return false;
    if (!validDate(value)) { invalid(label); return false; }
    return true;
  }
  function finish() {
    const decision = ["ERROR", "BLOCK", "REVIEW"].find(status => reasons.some(reason => reason.status === status)) || "ALLOW";
    for (const row of checks) {
      const affected = reasons.filter(reason => reason.rule_id === row.rule_id);
      row.status = ["ERROR", "BLOCK", "REVIEW"].find(status => affected.some(reason => reason.status === status)) ||
        (!calculationsValid && ["D02", "D03"].includes(row.rule_id) ? "NOT_EVALUATED" : "PASS");
    }
    if (input.audit_result_write === "FAILED") gate = "WAITING_AUDIT_REPAIR";
    else if (decision !== "ALLOW") gate = "NOT_ELIGIBLE";
    else if (input.idempotency_state === "ORIGINAL_EXECUTION_UNKNOWN") gate = "WAITING_EXECUTION_RECONCILIATION";
    else if (input.idempotency_state === "SAME_CONTENT_ALREADY_SUCCEEDED") gate = "REPLAY_ORIGINAL";
    else if (["REJECTED", "REVOKED"].includes(input.approval_state)) gate = "DENIED";
    else if (input.approval_state === "APPROVED" && input.versions_current === true) gate = input.scope === "PAPER_PREFLIGHT" ? "READY_FOR_PAPER" : "CONFIRMED_NOT_EXECUTED";
    const eligible = decision === "ALLOW" && gate === "READY_FOR_PAPER" && input.gateway_connected === true && input.audit_intent_writable === true;
    return { contract_version: CONTRACT_VERSION, policy_version: POLICY_VERSION, risk_check_id: options.checkId || `daily-risk-${randomUUID()}`,
      checked_at: checkedAt, decision, check_complete: decision !== "ERROR", execution_allowed: false, execution_authorization: "NOT_GRANTED_BY_RISK_RESULT",
      checks, reasons, warnings, info, gate_reasons: gateReasons, metrics, projected_state: projectedState, gate,
      preflight_eligible: eligible, new_execution: false, receipt_status: "NOT_EXECUTED",
      unresolved_review_count: reasons.filter(reason => reason.status === "REVIEW").length,
      allowed_functions: ["VIEW_DIAGNOSIS", "COMPARE", ...(decision === "ALLOW" || reasons.every(reason => reason.acceptance_allowed) ? ["REQUEST_CONFIRMATION"] : ["REPAIR_INPUT"])],
      paused_functions: ["REAL_TRADE", "PAPER_TRADE"], data_mode: "USER_CONFIRMED_SYNTHETIC",
      analysis_continues: true, original_receipt_preserved: Boolean(input.original_execution_receipt),
      principal_only_analysis_allowed: input.fees_minor == null && money(input.action_amount_minor),
      prior_risk_status: input.new_recheck_completed && input.soft_goal_acceptance_state === "ACCEPTED_CURRENT_VERSION" ? "REVIEW" : null,
      original_review_preserved: Boolean(input.new_recheck_completed && input.soft_goal_acceptance_state === "ACCEPTED_CURRENT_VERSION") };
  }

  if (!facts || typeof facts !== "object" || Array.isArray(facts)) invalid("facts");
  if (input.currency !== undefined && input.currency !== "CNY") invalid("currency");
  if (input.amount_unit !== undefined && input.amount_unit !== "MINOR") invalid("amount_unit");
  for (const [key, value] of Object.entries(input)) if (key.endsWith("_minor") && key !== "budget_buckets_minor" && value !== undefined && value !== null && !money(value)) invalid(key);
  if (!VALID_SCOPES.has(input.scope)) invalid("scope");
  if (!ACTIONS.has(input.action_type)) {
    add("DAILY_DATA_REQUIRED", "REVIEW", "该动作尚未登记可复算的日常资金模型，请补充或改为受支持的动作。", { field: "action_type" });
    calculationsValid = false;
  }
  checkAmount(input.cash_ledger_minor, "cash_ledger_minor", false);
  checkAmount(input.cash_available_minor, "cash_available_minor", false);
  checkAmount(input.action_amount_minor, "action_amount_minor");
  checkAmount(input.fees_minor, "fees_minor");
  checkAmount(input.extra_nonoverlapping_hold_minor, "extra_nonoverlapping_hold_minor");
  date(input.as_of, "as_of"); date(input.action_at, "action_at");
  if (validDate(input.as_of) && validDate(input.action_at) && Date.parse(input.action_at) < Date.parse(input.as_of)) invalid("action_at before as_of");
  if (!Array.isArray(input.holds) || !Array.isArray(input.purposes) || !Array.isArray(input.income_events)) invalid("holds/purposes/income_events");
  if (Array.isArray(input.holds) && input.holds.length > 200 || Array.isArray(input.purposes) && input.purposes.length > 200 || Array.isArray(input.income_events) && input.income_events.length > 200) invalid("event_count");
  if (!Number.isSafeInteger(input.ledger_revision) || input.ledger_revision < 0) invalid("ledger_revision");
  if (!["COMPLETE_VERIFIED_SYNTHETIC_FIXTURE", "USER_CONFIRMED_SYNTHETIC"].includes(input.required_evidence)) {
    add("DAILY_DATA_REQUIRED", "REVIEW", "必需事实或资金用途尚未完成可信核对。", { field: "required_evidence" });
  }
  if (input.required_snapshot_validity === "EXPIRED_BY_PROVIDER") add("DAILY_DATA_STALE", "REVIEW", "必需快照超过提供方有效期，请更新并重检。");
  if (input.required_services === "SHARED_LEDGER_UNAVAILABLE") add("SHARED_LEDGER_UNAVAILABLE", "ERROR", "共享资金核验不可用，相关操作保持暂停。");
  else if (input.required_services !== "AVAILABLE") add("DAILY_CHECK_UNAVAILABLE", "ERROR", "必要余额或计算服务不可用，不能签发执行资格。");
  if (input.required_evidence === "INCONSISTENT" || input.required_snapshot_validity === "INCONSISTENT") invalid("required_evidence");
  if (!["ENABLED_CONFIRMED", "DISABLED_CONFIRMED"].includes(input.hard_floor_state)) {
    add("DAILY_DATA_REQUIRED", "REVIEW", "现金保底尚未确定，不能把未知当作已确认零元。", { field: "hard_floor_state" });
    calculationsValid = false;
  }
  if (input.hard_floor_state === "ENABLED_CONFIRMED") checkAmount(input.configured_hard_floor_minor ?? input.independent_hard_floor_minor, "configured_hard_floor_minor");
  for (const group of [input.holds, input.purposes, input.income_events]) if (Array.isArray(group)) for (const row of group) {
    if (!row || typeof row !== "object" || Array.isArray(row)) { invalid("event"); continue; }
    for (const [key, value] of Object.entries(row)) if (key.endsWith("_minor") && value !== null && (!money(value) || value < 0)) invalid(key);
  }
  const holds = Array.isArray(input.holds) ? input.holds.filter(row => row && typeof row === "object").filter(active) : [];
  const purposes = Array.isArray(input.purposes) ? input.purposes.filter(row => row && typeof row === "object") : [];
  const incomes = Array.isArray(input.income_events) ? input.income_events.filter(row => row && typeof row === "object") : [];
  for (const [rows, key] of [[holds, "hold_id"], [purposes, "purpose_id"], [incomes, "event_id"]]) {
    const values = rows.map(row => row[key]);
    if (values.some(value => typeof value !== "string" || !value) || new Set(values).size !== values.length) {
      add("SHARED_FUNDS_RECONCILIATION_REQUIRED", "REVIEW", "记录标识缺失或重复，须核对是否同一笔资金。", { field: key }); calculationsValid = false;
    }
  }
  for (const purpose of purposes) {
    checkAmount(purpose.reserved_now_minor, `purpose:${purpose.purpose_id}:reserved_now_minor`);
    checkAmount(purpose.remaining_due_minor, `purpose:${purpose.purpose_id}:remaining_due_minor`);
    if (purpose.remaining_due_minor > 0) date(purpose.due_at || purpose.due_date, `purpose:${purpose.purpose_id}:due_at`);
    if (purpose.confirmed === false) { add("DAILY_DATA_REQUIRED", "REVIEW", "资金用途尚未由用户确认。", { purpose_id: purpose.purpose_id }); calculationsValid = false; }
  }
  for (const hold of holds) {
    checkAmount(hold.amount_minor, `hold:${hold.hold_id}:amount_minor`);
    const covered = hold.covered_reserved_minor ?? 0;
    if (!money(covered) || covered < 0 || covered > hold.amount_minor || covered > 0 && (hold.settlement_link !== "VERIFIED" || !purposes.some(row => row.purpose_id === hold.purpose_id))) invalid(`hold:${hold.hold_id}:coverage`);
    if (hold.settlement_link !== "VERIFIED" && hold.purpose_id) { add("SHARED_FUNDS_RECONCILIATION_REQUIRED", "REVIEW", "占用与资金用途关联尚未核实，不能自动抵减专款。", { hold_id: hold.hold_id }); calculationsValid = false; }
  }
  for (const income of incomes) {
    checkAmount(income.amount_minor, `income:${income.event_id}:amount_minor`);
    if (income.included_in_balance === true || income.status === "POSTED_INCLUDED") continue;
    date(income.at || income.date, `income:${income.event_id}:at`);
    if (!["EXPECTED", "RECEIVED", "POSTED", "POSTED_INCLUDED"].includes(income.status)) { add("DAILY_DATA_REQUIRED", "REVIEW", "收入到账状态未知，不能默认这笔收入已可用。", { event_id: income.event_id }); calculationsValid = false; }
    if (income.restricted_purpose_id || income.purpose_id || income.restricted === true) {
      add("DAILY_DATA_REQUIRED", "REVIEW", "未来专款收入需要提供到款后的用途保护关联，不能作为无用途限制的收入。", { event_id: income.event_id }); calculationsValid = false;
    }
    if (validDate(income.at || income.date) && validDate(input.as_of) && Date.parse(income.at || income.date) <= Date.parse(input.as_of)) {
      add("SHARED_FUNDS_RECONCILIATION_REQUIRED", "REVIEW", "到期收入尚未说明是否已含在余额中，请核对，不能再次增加现金。", { event_id: income.event_id }); calculationsValid = false;
    }
  }
  if (input.versions_current === false) add("DAILY_APPROVAL_STALE", "REVIEW", "方案、资金或约束版本已变化，需要重新检查与确认。");
  if (input.permission_granted === false || input.action_source === "EXTERNAL_CONTENT") add("PERMISSION_DENIED", "BLOCK", "当前操作没有可信用户权限，外部内容不能扩大授权。");
  if (input.proposed_tool === "REAL_TRADE" || input.requested_operation === "REAL_TRADE") add("REAL_TRADING_FORBIDDEN", "BLOCK", "当前环境禁止真实交易，模型提议不能改变这一边界。");
  if (input.proposed_tool && !["PAPER_ANALYSIS", "PAPER_TRADE", "daily.analyze", "daily.simulate", "REAL_TRADE"].includes(input.proposed_tool)) add("PERMISSION_DENIED", "BLOCK", "拟议工具未登记在当前日常任务允许范围内。", { tool: input.proposed_tool });
  if (input.external_note) add("UNTRUSTED_INSTRUCTION_IGNORED", "INFO", "备注或外部文字仅作为不可信业务数据，不更改权限、保护或审批。", {}, "info");
  if (input.idempotency_state === "SAME_KEY_DIFFERENT_CONTENT") add("IDEMPOTENCY_CONTENT_CONFLICT", "BLOCK", "同一执行标识对应不同内容，不允许写入。");
  if (input.scope === "PAPER_PREFLIGHT") {
    if (input.gateway_connected !== true) add("GATEWAY_NOT_CONNECTED", "ERROR", "受控模拟网关尚未接通，执行保持关闭。");
    if (input.audit_intent_writable !== true) add("AUDIT_WRITE_FAILED", "ERROR", "执行前审计未可靠写入，不能调用执行工具。");
  }
  if (input.audit_result_write === "FAILED") add("AUDIT_WRITE_FAILED", "ERROR", "已有执行结果，但结果审计补写失败；保留回执，不重复扣款。");
  if (input.idempotency_state === "ORIGINAL_EXECUTION_UNKNOWN") add("EXECUTION_STATUS_UNKNOWN", "GATE_WAIT", "先核查原执行，不重试或释放原占用。", {}, "gate");
  else if (input.idempotency_state === "SAME_CONTENT_ALREADY_SUCCEEDED") add("DUPLICATE_REQUEST_REPLAYED", "REPLAY", "返回已保存回执，不新增账本写入。", {}, "gate");
  if (["REJECTED", "REVOKED"].includes(input.approval_state)) add(input.approval_state === "REJECTED" ? "APPROVAL_REJECTED" : "APPROVAL_REVOKED", "GATE_DENY", "用户已拒绝或撤回本次计划，执行端不能继续。", {}, "gate");
  else if (input.approval_state !== "APPROVED") add("APPROVAL_REQUIRED", "GATE_WAIT", "风险检查与计划确认分开；当前尚未获得完整计划授权。", {}, "gate");
  if (!calculationsValid) return finish();

  try {
    const floorAmount = input.hard_floor_state === "ENABLED_CONFIRMED" ? input.configured_hard_floor_minor ?? input.independent_hard_floor_minor : 0;
    const floor = rows => {
      const coverage = rows.find(row => row.purpose_id === input.hard_floor_covered_by_purpose)?.reserved_now_minor || 0;
      return Math.max(0, floorAmount - Math.min(floorAmount, coverage));
    };
    const balance = (cash, reserved, frozen) => {
      const holdTotal = sum(frozen.map(row => row.amount_minor));
      const uncovered = sum(reserved.map(purpose => {
        const coverage = sum(frozen.filter(row => row.purpose_id === purpose.purpose_id && row.settlement_link === "VERIFIED").map(row => row.covered_reserved_minor || 0));
        return Math.max(0, purpose.reserved_now_minor - coverage);
      }));
      const protectedTotal = sum(reserved.map(row => row.reserved_now_minor));
      const independentFloor = floor(reserved);
      const free = sum([cash, -holdTotal, -uncovered, -independentFloor]);
      return { cash, holdTotal, uncovered, protectedTotal, independentFloor, free, available: cash - holdTotal };
    };
    const before = balance(input.cash_ledger_minor, purposes, holds);
    if (before.available !== input.cash_available_minor) {
      add("SHARED_FUNDS_RECONCILIATION_REQUIRED", "REVIEW", "账面现金减占用与净可用额不一致，先对账，不能重复扣冻结。", { ledger_minor: before.cash, holds_minor: before.holdTotal, reported_available_minor: input.cash_available_minor });
      calculationsValid = false; return finish();
    }
    metrics.free_before_minor = before.free;
    metrics.available_for_new_action_minor = Math.max(0, before.free);
    metrics.existing_shortfall_minor = Math.max(0, -before.free);
    metrics.protected_before_minor = before.protectedTotal;
    metrics.holds_before_minor = before.holdTotal;
    const nextPurposes = structuredClone(purposes), nextHolds = structuredClone(holds);
    let nextCash = before.cash;
    const total = sum([input.action_amount_minor, input.fees_minor, input.extra_nonoverlapping_hold_minor]);
    let matched = null, matchedVerified = true;
    const settleHold = nextHolds.find(row => row.hold_id === input.settle_hold_id);
    if (["PURPOSE_PAYMENT", "SETTLE_EXISTING_HOLD"].includes(input.action_type)) {
      if (input.action_type === "PURPOSE_PAYMENT") {
        matched = nextPurposes.find(row => row.purpose_id === input.matched_purpose_id);
        if (!matched || input.purpose_link !== "VERIFIED_FOR_SETTLEMENT") {
          add("PURPOSE_LINK_UNVERIFIED", "REVIEW", "原用途支付需要可信账单关联，备注中的用途名称不足以解除保护。", { purpose_id: input.matched_purpose_id || null }); matchedVerified = false;
        } else if (input.action_amount_minor > matched.remaining_due_minor) {
          add("DAILY_DATA_REQUIRED", "REVIEW", "付款超出该义务尚欠额，超出部分需要独立确认用途。", { field: "action_amount_minor" }); matchedVerified = false;
        }
      }
      if (input.settle_hold_id && (!settleHold || settleHold.settlement_link !== "VERIFIED" || matched && settleHold.purpose_id !== matched.purpose_id)) {
        add("PURPOSE_LINK_UNVERIFIED", "REVIEW", "待结算占用不存在或用途关联未核实，不能自动释放。", { hold_id: input.settle_hold_id }); matchedVerified = false;
      }
      if (input.action_type === "SETTLE_EXISTING_HOLD" && !settleHold) {
        add("PURPOSE_LINK_UNVERIFIED", "REVIEW", "需要关联有效的原占用，不能把新付款伪装为结算。", { field: "settle_hold_id" }); matchedVerified = false;
      }
      if (matchedVerified) {
        nextCash -= input.action_amount_minor + input.fees_minor;
        if (matched) {
          matched.reserved_now_minor -= Math.min(matched.reserved_now_minor, input.action_amount_minor);
          matched.remaining_due_minor -= Math.min(matched.remaining_due_minor, input.action_amount_minor);
          const due = matched.due_at || matched.due_date;
          if (validDate(due) && Date.parse(input.action_at) > Date.parse(due)) add("PAYMENT_DATE_GAP", "BLOCK", "安排的原用途付款时间晚于已确认到期时间，需要修正付款安排。", { due_at: due, action_at: input.action_at });
        }
        if (settleHold) {
          const released = Math.min(settleHold.amount_minor, input.action_amount_minor);
          settleHold.amount_minor -= released;
          settleHold.covered_reserved_minor = Math.max(0, (settleHold.covered_reserved_minor || 0) - released);
        }
      }
    } else if (input.action_type === "OPTIONAL_INVESTMENT") {
      nextHolds.push({ hold_id: `projection-${digest({ amount: total, at: input.action_at }).slice(0, 16)}`, amount_minor: total, covered_reserved_minor: 0, purpose_id: null, settlement_link: "VERIFIED", task_id: input.task_id || "CURRENT_TASK" });
    } else if (input.action_type !== "ANALYSIS_ONLY") {
      nextCash -= input.action_amount_minor + input.fees_minor;
      if (input.extra_nonoverlapping_hold_minor) nextHolds.push({ hold_id: "projection-extra", amount_minor: input.extra_nonoverlapping_hold_minor, covered_reserved_minor: 0, settlement_link: "VERIFIED" });
    }
    const after = balance(nextCash, nextPurposes, nextHolds);
    Object.assign(metrics, { free_after_hold_minor: after.free, projected_free_after_minor: after.free, projected_cash_after_minor: after.cash,
      projected_holds_after_minor: after.holdTotal, projected_available_after_minor: after.available, projected_protected_after_minor: after.protectedTotal,
      projected_independent_floor_minor: after.independentFloor, shortfall_minor: Math.max(0, -after.free),
      new_shortfall_minor: Math.max(0, -after.free) - Math.max(0, -before.free),
      incremental_shortfall_minor: Math.max(0, -after.free) - Math.max(0, -before.free), after_action_shortfall_minor: Math.max(0, -after.free),
      action_total_minor: total });
    if (matched?.purpose_id === "tuition") Object.assign(metrics, { projected_tuition_reserved_minor: matched.reserved_now_minor, projected_tuition_due_minor: matched.remaining_due_minor, repeat_tuition_outflow_at_due_date: matched.remaining_due_minor > 0 });
    if (matchedVerified) {
      if (after.available < 0) add("PAYMENT_CASH_INSUFFICIENT", "BLOCK", "当前可结算现金不足，不能完成本次安排。", { shortfall_minor: -after.available });
      if (after.free < 0 && total > 0) {
        const code = after.cash - after.holdTotal - after.uncovered < after.independentFloor && after.independentFloor > before.independentFloor ? "HARD_FLOOR_CONFLICT" : "PROTECTED_PURPOSE_CONFLICT";
        add(code, "BLOCK", code === "HARD_FLOOR_CONFLICT" ? "支用原覆盖用途后，已确认最低现金重新形成缺口。" : "本次安排会占用已确认的学费、生活费或其他保护资金。", { shortfall_minor: -after.free, incremental_shortfall_minor: metrics.incremental_shortfall_minor });
        if (holds.length && before.free < total && input.action_type !== "PURPOSE_PAYMENT" && input.action_type !== "SETTLE_EXISTING_HOLD") add("SHARED_FUNDS_CONFLICT", "BLOCK", "其他任务已占用部分现金，本次安排超过共享可用额度。", { holds_minor: before.holdTotal });
      }
    }
    if (input.hard_floor_state === "ENABLED_CONFIRMED" && matchedVerified && after.cash - after.holdTotal < after.independentFloor && !reasons.some(row => row.code === "HARD_FLOOR_CONFLICT")) add("HARD_FLOOR_CONFLICT", "BLOCK", "剩余现金不足以保留已确认的独立最低现金。", { threshold_minor: after.independentFloor });
    projectedState = { cash_ledger_minor: after.cash, cash_available_minor: after.available, holds: nextHolds.filter(row => row.amount_minor > 0), purposes: nextPurposes };

    // Each cash-flow run starts from one ledger snapshot. Reservations are not a
    // second cash expense; linked holds are released when that obligation settles.
    function cashflow(rows, frozen, initialCash, delayDays = 0, optimistic = false, planned = false) {
      const events = [], snapshot = Date.parse(input.as_of);
      for (const income of incomes) {
        if (income.included_in_balance === true || income.status === "POSTED_INCLUDED") continue;
        const at = income.at || income.date;
        if (!validDate(at) || Date.parse(at) <= snapshot) continue;
        const shifted = new Date(Date.parse(at) + delayDays * 86400000).toISOString();
        events.push({ event_id: income.event_id, kind: "INCOME", amount_minor: income.amount_minor, at: shifted, day: isoDay(delayDays ? shifted : at), uncertain: income.time_precision === "DAY" || at.length === 10 });
      }
      for (const purpose of rows) if (purpose.remaining_due_minor > 0) {
        const at = purpose.due_at || purpose.due_date;
        if (!validDate(at)) continue;
        const releasable = sum(frozen.filter(hold => hold.purpose_id === purpose.purpose_id && hold.settlement_link === "VERIFIED").map(hold => Math.min(hold.amount_minor, hold.covered_reserved_minor || 0)));
        events.push({ event_id: purpose.purpose_id, kind: "PAYMENT", amount_minor: -purpose.remaining_due_minor, release_minor: Math.min(purpose.remaining_due_minor, releasable), at, day: isoDay(at), uncertain: purpose.time_precision === "DAY" || at.length === 10 });
      }
      if (planned && after.available !== before.available) events.push({ event_id: "PROPOSED_ACTION", kind: "ACTION", amount_minor: after.available - before.available, at: input.action_at, day: isoDay(input.action_at), uncertain: input.action_at.length === 10 });
      events.sort((a, b) => {
        if (a.day !== b.day) return a.day.localeCompare(b.day);
        if ((a.uncertain || b.uncertain) && a.kind !== b.kind) return optimistic ? (a.kind === "INCOME" ? -1 : 1) : (a.kind === "PAYMENT" ? -1 : 1);
        return Date.parse(a.at) - Date.parse(b.at);
      });
      let current = planned ? before.available : initialCash - sum(frozen.map(hold => hold.amount_minor));
      let gap = Math.max(0, -current), gapDate = gap ? isoDay(input.as_of) : null;
      const path = [{ at: input.as_of, event_id: "OPENING", kind: "OPENING", balance_minor: current }];
      for (const event of events) {
        current = sum([current, event.amount_minor, event.release_minor || 0]);
        path.push({ ...event, balance_minor: current });
        if (-current > gap) { gap = -current; gapDate = event.day; }
      }
      return { gap_minor: gap, gap_date: gapDate, path };
    }
    const baseline = cashflow(purposes, holds, before.cash);
    const forecast = cashflow(nextPurposes, nextHolds, after.cash, 0, false, true);
    const optimistic = cashflow(nextPurposes, nextHolds, after.cash, 0, true, true);
    const ambiguous = forecast.gap_minor > optimistic.gap_minor;
    metrics.cashflow = forecast.path;
    metrics.baseline_date_gap_minor = baseline.gap_minor;
    metrics.after_action_date_gap_minor = forecast.gap_minor;
    metrics.gap_date = forecast.gap_date;
    if (ambiguous) add("PAYMENT_ORDER_UNVERIFIED", "REVIEW", "同日收付先后未核实，顺序会影响付款覆盖，请补充到账和付款时间。", { pessimistic_gap_minor: forecast.gap_minor, optimistic_gap_minor: optimistic.gap_minor });
    if ((ambiguous ? optimistic.gap_minor : forecast.gap_minor) > 0 && matchedVerified) add("PAYMENT_DATE_GAP", "BLOCK", "按当前计划及已列明的收入假设，相关付款日出现现金缺口。", { gap_minor: ambiguous ? optimistic.gap_minor : forecast.gap_minor, date: forecast.gap_date });
    if (incomes.some(row => row.status === "EXPECTED" && row.included_in_balance !== true)) add("FUTURE_CASHFLOW_ASSUMPTION", "INFO", "未来视图依赖列明的预计到账；预计工资没有增加当前可用现金。", {}, "info");
    if (input.stress_assumption) {
      const delay = input.stress_assumption.salary_delay_days;
      if (!Number.isInteger(delay) || delay < 0 || delay > 366) add("DAILY_DATA_REQUIRED", "REVIEW", "压力情景需要明确、有效的延迟天数。", { field: "stress_assumption" });
      else {
        const stress = cashflow(nextPurposes, nextHolds, after.cash, delay, false, true);
        metrics.stress_gap_minor = stress.gap_minor; metrics.stress_gap_date = stress.gap_date; metrics.probability = null;
        if (stress.gap_minor > 0) add("CASHFLOW_STRESS_GAP", "WARNING", "在指定工资延迟假设下可能出现缺口；这不是确定事实或发生概率。", { gap_minor: stress.gap_minor, date: stress.gap_date, assumption: input.stress_assumption });
      }
    }
  } catch (error) { invalid(error.message === "AMOUNT_OVERFLOW" ? "amount_sum_overflow" : "calculation"); }

  function soft(code, message, details) {
    add(code, "WARNING", message, details);
    if (input.soft_goal_acceptance_required === true && !(input.soft_goal_acceptance_state === "ACCEPTED_CURRENT_VERSION" && input.new_recheck_completed === true && input.versions_current === true)) add(code, "REVIEW", message, { ...details, acceptance_allowed: true });
  }
  if (["SUBSCRIPTION_PAYMENT", "OPTIONAL_PAYMENT"].includes(input.action_type) && input.category_budget_remaining_minor !== undefined) {
    if (!money(input.category_budget_remaining_minor)) invalid("category_budget_remaining_minor");
    else {
      metrics.budget_over_minor = Math.max(0, input.action_amount_minor + (input.fees_minor || 0) - input.category_budget_remaining_minor);
      if (metrics.budget_over_minor > 0) soft("PERSONAL_BUDGET_EXCEEDED", "本次消费超过个人柔性预算，默认提醒，不自动放宽必要资金保护。", { over_minor: metrics.budget_over_minor });
    }
  }
  if (input.budget_reference_enabled === true) {
    if (!money(input.period_take_home_minor) || input.period_take_home_minor < 0 || !input.budget_buckets_minor) add("DAILY_DATA_REQUIRED", "REVIEW", "启用预算模板需要同期间税后收入与去重分类数据。", { field: "budget_reference" });
    else if (input.period_take_home_minor === 0) metrics.metric_status.budget_reference = "NOT_APPLICABLE";
    else {
      let deviation = false;
      for (const [bucket, threshold] of Object.entries(registry.parameters.budget_reference.reference_bps)) {
        const value = input.budget_buckets_minor[bucket];
        if (!money(value) || value < 0) { invalid(`budget_buckets_minor:${bucket}`); continue; }
        metrics[`${bucket}_bps`] = value / input.period_take_home_minor * 10000;
        const left = BigInt(value) * 10000n, right = BigInt(input.period_take_home_minor) * BigInt(threshold);
        if (bucket === "goals" ? left < right : left > right) deviation = true;
      }
      if (deviation) soft("BUDGET_REFERENCE_DEVIATION", "现金分配偏离选定参考比例；比例是讨论工具，不是统一硬性标准。", { income_basis: "TAKE_HOME_SAME_PERIOD" });
    }
  }
  if (input.emergency_target_enabled === true) {
    const allocation = input.emergency_allocation_before_minor;
    let used = input.action_uses_emergency_allocation_minor;
    if (input.emergency_within_free_cash === true && money(allocation) && money(metrics.free_before_minor) && money(metrics.projected_free_after_minor)) {
      if (allocation > Math.max(0, metrics.free_before_minor)) add("DAILY_DATA_REQUIRED", "REVIEW", "应急目标中的资金不能与学费等保护用途或已占用资金重复计算。", { field: "emergency_nonoverlap" });
      used = Math.max(0, allocation - Math.max(0, metrics.projected_free_after_minor));
      metrics.emergency_allocation_after_minor = Math.max(0, allocation - used);
      metrics.emergency_basis = "USER_DESIGNATED_WITHIN_FREE_CASH_OTHER_FREE_CASH_USED_FIRST";
    }
    if (!money(allocation) || !money(used) || allocation < 0 || used < 0 || used > allocation || !money(input.monthly_essential_minor) || input.monthly_essential_minor < 0 || typeof input.target_months !== "number" || !Number.isFinite(input.target_months) || input.target_months < 0) add("DAILY_DATA_REQUIRED", "REVIEW", "应急目标需明确专用储备、必要月支出及不重叠的使用范围。", { field: "emergency_target" });
    else if (input.monthly_essential_minor === 0) metrics.metric_status.emergency_months = "NOT_APPLICABLE";
    else {
      metrics.emergency_months = (allocation - used) / input.monthly_essential_minor;
      if (metrics.emergency_months < input.target_months) soft("RESERVE_TARGET_SHORTFALL", "专用应急储备低于个人柔性目标，不等同于违反硬性保底。", { months: metrics.emergency_months, target_months: input.target_months });
    }
  }
  if (input.plan_depends_on_redeeming_other_asset === true || input.action_uses_purpose_id) {
    const purpose = purposes.find(row => row.purpose_id === input.action_uses_purpose_id);
    const due = input.protected_due_at || purpose?.due_at || purpose?.due_date;
    const earliest = input.earliest_reliable_available_at, latest = input.latest_reliable_available_at;
    if (validDate(due) && validDate(earliest) && Date.parse(earliest) > Date.parse(due)) add("LIQUIDITY_DATE_MISMATCH", "BLOCK", "最早可靠可用时间已晚于用款日，不能覆盖该笔付款。", { due_at: due, earliest_available_at: earliest });
    else if (!validDate(due) || !validDate(latest) || input.redemption_evidence === null || Date.parse(latest) > Date.parse(due)) add("LIQUIDITY_EVIDENCE_REQUIRED", "REVIEW", "需要有证据支持的最晚可用时间；仅有最早到账日不能证明赶得上。", { due_at: due || null, latest_available_at: latest || null });
  }
  metrics.metric_status.standard_dti = input.gross_monthly_total_income === 0 ? "NOT_APPLICABLE" : input.gross_monthly_total_income == null ? "NOT_EVALUATED" : "NOT_EVALUATED";
  metrics.metric_status.salary_based_ratio = input.salary_minor === 0 ? "NOT_APPLICABLE" : "NOT_EVALUATED";
  metrics.metric_status.food_tobacco_alcohol_share = "NOT_EVALUATED";
  if (input.card_purchase_minor !== undefined) metrics.consumption_view_purchase_minor = input.card_purchase_minor;
  if (input.confirmed_full_card_repayment_minor !== undefined) metrics.cash_allocation_view_repayment_minor = input.confirmed_full_card_repayment_minor;
  return finish();
}

module.exports = { evaluateDaily, describePolicy, POLICY_VERSION };
