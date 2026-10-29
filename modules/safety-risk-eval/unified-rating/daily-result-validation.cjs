"use strict";
// Internal result validation, not HTTP authentication or a replacement ledger.
const registry = require("../../../docs/safety-risk-eval/daily-policy-v1/policy-config.v1.json");
const runtime = require("./runtime-config.v1.1.json");
const definitions = new Map(registry.rules.flatMap(rule => rule.reasons.map(row => [row.code, { ...row, rule_id: rule.rule_id }])));
const softCodes = new Set(["PERSONAL_BUDGET_EXCEEDED", "BUDGET_REFERENCE_DEVIATION", "RESERVE_TARGET_SHORTFALL"]);
const priority = rows => ["ERROR", "BLOCK", "REVIEW"].find(status => rows.some(row => row.status === status)) || "ALLOW";
const coreMetrics = ["free_before_minor", "projected_free_after_minor", "shortfall_minor"];
const nonnegative = new Set(["shortfall_minor", "available_for_new_action_minor", "existing_shortfall_minor", "protected_before_minor", "holds_before_minor", "projected_holds_after_minor", "projected_protected_after_minor", "projected_independent_floor_minor", "action_total_minor", "baseline_date_gap_minor", "after_action_date_gap_minor", "budget_over_minor", "emergency_allocation_after_minor", "after_action_shortfall_minor"]);
const dataProperties = value => Reflect.ownKeys(value).every(key => typeof key === "string" && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), "value"));
const plain = value => !!value && typeof value === "object" && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)) && dataProperties(value);
const array = value => Array.isArray(value) && value.length <= 2000 && dataProperties(value);
const text = value => typeof value === "string" && value.length > 0 && value.length <= 5000;
const number = value => Number.isSafeInteger(value);
const date = value => typeof value === "string" && Number.isFinite(Date.parse(value));

function validateDailyResult(result) {
  const errors = [];
  const add = (code, message_zh, path) => { if (errors.length < 100) errors.push({ code, message_zh, path }); };
  const finish = status => ({ validation_status: status || (errors.length ? "INVALID" : "VALID"), validation_errors: errors });
  try {
    if (!plain(result)) { add("RESULT_STRUCTURE_INVALID", "检查结果不是可核验的普通对象。", "result"); return finish(); }
    if (result.contract_version !== runtime.supported_source_contract || result.policy_version !== runtime.supported_source_policy) {
      add("RESULT_VERSION_UNSUPPORTED", "该检查契约或规则版本尚无经过验证的适配器。", "contract_version/policy_version"); return finish("UNSUPPORTED");
    }
    if (!text(result.risk_check_id) || !date(result.checked_at)) add("RESULT_STRUCTURE_INVALID", "缺少有效检查编号或检查时间。", "risk_check_id/checked_at");
    if (!["ALLOW", "REVIEW", "BLOCK", "ERROR"].includes(result.decision)) add("RESULT_DECISION_INVALID", "检查结果的风险状态无效。", "decision");
    if (result.check_complete !== (result.decision !== "ERROR")) add("RESULT_STATUS_INCONSISTENT", "检查完整性标记与原引擎状态不一致。", "check_complete");
    if (result.execution_allowed !== false) add("RESULT_EXECUTION_AUTHORITY_INVALID", "风险结果不得自行授予执行权限。", "execution_allowed");
    if (!["reasons", "warnings", "info", "gate_reasons", "checks"].every(key => array(result[key])) || !plain(result.metrics)) { add("RESULT_STRUCTURE_INVALID", "风险原因、检查列表或指标结构无法核验。", "reasons/checks/metrics"); return finish(); }
    const rows = [], byId = new Map();
    for (const channel of ["reasons", "warnings", "info", "gate_reasons"]) for (let index = 0; index < result[channel].length; index++) {
      const row = result[channel][index], at = `${channel}[${index}]`;
      if (!plain(row) || !text(row.reason_id) || !text(row.message_zh) || typeof row.acceptance_allowed !== "boolean" || !plain(row.recovery) || !text(row.recovery.message_zh) || !array(row.evidence_refs)) { add("RESULT_REASON_STRUCTURE_INVALID", "风险原因缺少编号、说明、恢复方式或有效证据列表。", at); continue; }
      const definition = definitions.get(row.code);
      if (!definition || row.rule_id !== definition.rule_id) { add("RESULT_REASON_CODE_INVALID", "风险原因代码或所属规则未登记。", at); continue; }
      const promoted = softCodes.has(row.code) && row.status === "REVIEW" && row.acceptance_allowed === true, effect = definition.effect;
      const expectedChannel = promoted || ["ERROR", "BLOCK", "REVIEW"].includes(effect) ? "reasons" : effect === "WARNING" ? "warnings" : effect === "INFO" ? "info" : "gate_reasons";
      if (!(row.status === effect || promoted) || channel !== expectedChannel || row.acceptance_allowed === true && !promoted) add("RESULT_REASON_STATUS_MISMATCH", "风险原因的状态、通道或可接受标记与规则不一致。", at);
      if (row.decision !== (["REVIEW", "BLOCK", "ERROR"].includes(row.status) ? row.status : null)) add("RESULT_REASON_STATUS_MISMATCH", "风险原因的决策字段与原因状态不一致。", `${at}.decision`);
      if (byId.has(row.reason_id)) add("RESULT_REASON_REFERENCE_INVALID", "风险原因编号重复，无法唯一关联审计证据。", `${at}.reason_id`);
      byId.set(row.reason_id, row); rows.push(row);
      if (promoted && !result.warnings.some(w => plain(w) && w.code === row.code && w.status === "WARNING")) add("RESULT_REASON_STATUS_MISMATCH", "逐项接受复核缺少对应的软提醒证据。", at);
    }
    if (result.checks.length !== registry.rules.length || result.checks.some(row => !plain(row)) || new Set(result.checks.filter(plain).map(row => row.rule_id)).size !== registry.rules.length) add("RESULT_CHECKS_INVALID", "规则检查必须完整且每条规则只有一项结果。", "checks");
    const riskRows = result.reasons.filter(plain);
    if (result.decision !== priority(riskRows)) add("RESULT_STATUS_INCONSISTENT", "总风险判定与全部原因的优先级不一致。", "decision");
    const unavailable = riskRows.some(row => ["D01", "D04"].includes(row.rule_id) && ["REVIEW", "ERROR"].includes(row.status));
    for (const rule of registry.rules) {
      const check = result.checks.find(row => plain(row) && row.rule_id === rule.rule_id);
      if (!check || !array(check.reason_ids) || check.reason_ids.some(id => !text(id))) { add("RESULT_CHECKS_INVALID", "检查项或原因引用列表缺失。", `checks.${rule.rule_id}`); continue; }
      const refs = new Set(rows.filter(row => row.rule_id === rule.rule_id).map(row => row.reason_id)), actual = new Set(check.reason_ids);
      if (actual.size !== refs.size || [...actual].some(id => !refs.has(id) || byId.get(id)?.rule_id !== rule.rule_id)) add("RESULT_REASON_REFERENCE_INVALID", "检查原因引用缺失、越界或指向其他规则。", `checks.${rule.rule_id}.reason_ids`);
      const state = priority(riskRows.filter(row => row.rule_id === rule.rule_id)), expected = state === "ALLOW" ? "PASS" : state;
      const allowedNotEvaluated = expected === "PASS" && ["D02", "D03"].includes(rule.rule_id) && unavailable;
      if (check.status !== expected && !(allowedNotEvaluated && check.status === "NOT_EVALUATED")) add("RESULT_STATUS_INCONSISTENT", "规则检查状态与关联风险原因不一致。", `checks.${rule.rule_id}.status`);
    }
    if (result.unresolved_review_count !== riskRows.filter(row => row.status === "REVIEW").length) add("RESULT_STATUS_INCONSISTENT", "待复核数量与风险原因不一致。", "unresolved_review_count");
    const metrics = result.metrics;
    const calculationComplete = coreMetrics.every(key => number(metrics[key])) && !result.checks.some(row => plain(row) && ["D02", "D03"].includes(row.rule_id) && row.status === "NOT_EVALUATED");
    if (metrics.currency !== "CNY" || metrics.amount_unit !== "MINOR") add("RESULT_METRIC_INVALID", "指标必须使用人民币整数分。", "metrics.currency/amount_unit");
    for (const key of coreMetrics) if (!Object.hasOwn(metrics, key) || metrics[key] !== null && !number(metrics[key])) add("RESULT_METRIC_INVALID", "核心金额必须是整数分或明确未知。", `metrics.${key}`);
    for (const [key, value] of Object.entries(metrics)) if (key.endsWith("_minor") && value !== null && (!number(value) || nonnegative.has(key) && value < 0)) add("RESULT_METRIC_INVALID", "金额指标无效、超出安全范围或出现不允许的负值。", `metrics.${key}`);
    if (!coreMetrics.every(key => number(metrics[key])) && !unavailable) add("RESULT_METRIC_INCOMPLETE", "未完成资金计算却缺少相关数据或计算失败原因。", "metrics");
    if (calculationComplete) {
      const requiredAmounts = ["available_for_new_action_minor", "existing_shortfall_minor", "protected_before_minor", "holds_before_minor", "free_after_hold_minor", "projected_cash_after_minor", "projected_holds_after_minor", "projected_available_after_minor", "projected_protected_after_minor", "projected_independent_floor_minor", "new_shortfall_minor", "incremental_shortfall_minor", "after_action_shortfall_minor", "action_total_minor", "baseline_date_gap_minor", "after_action_date_gap_minor"];
      for (const key of requiredAmounts) if (!Object.hasOwn(metrics, key) || !number(metrics[key])) add("RESULT_METRIC_INCOMPLETE", "完整资金计算缺少可复核的必要金额指标。", `metrics.${key}`);
      if (!Object.hasOwn(metrics, "cashflow")) add("RESULT_METRIC_INCOMPLETE", "完整资金计算缺少对应的日期现金流路径。", "metrics.cashflow");
      if (!plain(result.projected_state)) add("RESULT_METRIC_INCOMPLETE", "完整资金计算缺少对应的拟议资金状态。", "projected_state");
    }
    function equals(key, dependencies, calculate) {
      if (number(metrics[key]) && dependencies.every(name => number(metrics[name])) && BigInt(metrics[key]) !== calculate(...dependencies.map(name => BigInt(metrics[name])))) add("RESULT_METRIC_INCONSISTENT", "资金指标与同一结果中的可复算关系不一致。", `metrics.${key}`);
    }
    const maxZero = value => value > 0n ? value : 0n;
    equals("available_for_new_action_minor", ["free_before_minor"], maxZero);
    equals("existing_shortfall_minor", ["free_before_minor"], value => maxZero(-value));
    equals("shortfall_minor", ["projected_free_after_minor"], value => maxZero(-value));
    equals("after_action_shortfall_minor", ["shortfall_minor"], value => value);
    equals("free_after_hold_minor", ["projected_free_after_minor"], value => value);
    equals("projected_available_after_minor", ["projected_cash_after_minor", "projected_holds_after_minor"], (cash, holds) => cash - holds);
    equals("new_shortfall_minor", ["shortfall_minor", "existing_shortfall_minor"], (after, before) => after - before);
    equals("incremental_shortfall_minor", ["new_shortfall_minor"], value => value);
    const has = code => riskRows.some(row => row.code === code);
    if (number(metrics.budget_over_minor) && metrics.budget_over_minor > 0 && !result.warnings.some(row => plain(row) && row.code === "PERSONAL_BUDGET_EXCEEDED")) add("RESULT_FINANCIAL_FINDING_MISSING", "指标已显示个人预算超额，但缺少对应的软提醒。", "metrics.budget_over_minor");
    if (!has("PURPOSE_LINK_UNVERIFIED")) {
      if (number(metrics.shortfall_minor) && metrics.shortfall_minor > 0 && !["PROTECTED_PURPOSE_CONFLICT", "HARD_FLOOR_CONFLICT"].some(has)) add("RESULT_FINANCIAL_FINDING_MISSING", "指标已显示保护资金缺口，但缺少对应的风险原因。", "metrics.shortfall_minor");
      if (number(metrics.projected_available_after_minor) && metrics.projected_available_after_minor < 0 && !has("PAYMENT_CASH_INSUFFICIENT")) add("RESULT_FINANCIAL_FINDING_MISSING", "指标已显示可结算现金不足，但缺少对应的风险原因。", "metrics.projected_available_after_minor");
      if (number(metrics.after_action_date_gap_minor) && metrics.after_action_date_gap_minor > 0 && !has("PAYMENT_ORDER_UNVERIFIED") && !has("PAYMENT_DATE_GAP")) add("RESULT_FINANCIAL_FINDING_MISSING", "日期路径已显示付款缺口，但缺少对应的风险原因。", "metrics.after_action_date_gap_minor");
    }
    if (metrics.cashflow !== undefined) {
      if (!array(metrics.cashflow) || !metrics.cashflow.length) add("RESULT_METRIC_INVALID", "现金流路径结构无效。", "metrics.cashflow");
      else {
        let previous = null, gap = 0n;
        for (let i = 0; i < metrics.cashflow.length; i++) {
          const row = metrics.cashflow[i], at = `metrics.cashflow[${i}]`;
          if (!plain(row) || !number(row.balance_minor) || !date(row.at) || (i === 0 ? row.kind !== "OPENING" : !["INCOME", "PAYMENT", "ACTION"].includes(row.kind) || !number(row.amount_minor) || row.release_minor !== undefined && (!number(row.release_minor) || row.release_minor < 0))) { add("RESULT_METRIC_INVALID", "现金流事件、日期或金额无法核验。", at); previous = null; continue; }
          if (i > 0 && previous !== null && BigInt(row.balance_minor) !== previous + BigInt(row.amount_minor) + BigInt(row.release_minor || 0)) add("RESULT_METRIC_INCONSISTENT", "现金流余额与该步收付、占用释放不一致。", at);
          previous = BigInt(row.balance_minor); gap = gap > -previous ? gap : -previous;
        }
        if (number(metrics.after_action_date_gap_minor) && BigInt(metrics.after_action_date_gap_minor) !== gap) add("RESULT_METRIC_INCONSISTENT", "日期缺口与现金流路径不一致。", "metrics.after_action_date_gap_minor");
      }
    }
    if (result.projected_state !== null && result.projected_state !== undefined) {
      if (!plain(result.projected_state)) add("RESULT_STRUCTURE_INVALID", "模拟后状态结构无效。", "projected_state");
      else {
        const state = result.projected_state;
        for (const [key, metric] of [["cash_ledger_minor", "projected_cash_after_minor"], ["cash_available_minor", "projected_available_after_minor"]]) if (!number(state[key]) || !number(metrics[metric]) || state[key] !== metrics[metric]) add("RESULT_METRIC_INCONSISTENT", "模拟状态与结果指标不一致。", `projected_state.${key}`);
        let stateValid = array(state.holds) && array(state.purposes);
        if (!stateValid) add("RESULT_STRUCTURE_INVALID", "拟议状态缺少可核验的占用和保护用途。", "projected_state.holds/purposes");
        else {
          const purposeIds = new Set(), holdIds = new Set();
          for (const purpose of state.purposes) {
            if (!plain(purpose) || !text(purpose.purpose_id) || purposeIds.has(purpose.purpose_id) || !number(purpose.reserved_now_minor) || purpose.reserved_now_minor < 0 || !number(purpose.remaining_due_minor) || purpose.remaining_due_minor < 0 || purpose.remaining_due_minor > 0 && !date(purpose.due_at || purpose.due_date)) { stateValid = false; add("RESULT_STRUCTURE_INVALID", "拟议保护用途的标识、金额或付款日期无法核验。", "projected_state.purposes"); continue; }
            purposeIds.add(purpose.purpose_id);
          }
          for (const hold of state.holds) {
            const covered = plain(hold) ? hold.covered_reserved_minor ?? 0 : null;
            if (!plain(hold) || !text(hold.hold_id) || holdIds.has(hold.hold_id) || !number(hold.amount_minor) || hold.amount_minor <= 0 || !number(covered) || covered < 0 || covered > hold.amount_minor || covered > 0 && (hold.settlement_link !== "VERIFIED" || !purposeIds.has(hold.purpose_id))) { stateValid = false; add("RESULT_STRUCTURE_INVALID", "拟议占用的标识、金额或用途覆盖无法核验。", "projected_state.holds"); continue; }
            holdIds.add(hold.hold_id);
          }
        }
        if (stateValid) {
          const totalHolds = state.holds.reduce((total, hold) => total + BigInt(hold.amount_minor), 0n);
          const totalProtected = state.purposes.reduce((total, purpose) => total + BigInt(purpose.reserved_now_minor), 0n);
          const coveredBy = purpose => state.holds.filter(hold => hold.purpose_id === purpose.purpose_id && hold.settlement_link === "VERIFIED").reduce((total, hold) => total + BigInt(hold.covered_reserved_minor || 0), 0n);
          const uncovered = state.purposes.reduce((total, purpose) => total + maxZero(BigInt(purpose.reserved_now_minor) - coveredBy(purpose)), 0n);
          for (const [key, expected] of [["projected_holds_after_minor", totalHolds], ["projected_protected_after_minor", totalProtected]]) if (number(metrics[key]) && BigInt(metrics[key]) !== expected) add("RESULT_METRIC_INCONSISTENT", "拟议占用或保护用途汇总与金额指标不一致。", `metrics.${key}`);
          if (number(state.cash_ledger_minor) && number(metrics.projected_independent_floor_minor) && number(metrics.projected_free_after_minor) && BigInt(metrics.projected_free_after_minor) !== BigInt(state.cash_ledger_minor) - totalHolds - uncovered - BigInt(metrics.projected_independent_floor_minor)) add("RESULT_METRIC_INCONSISTENT", "拟议可自由安排资金未扣除可复算的占用、未覆盖保护用途和独立现金保底。", "metrics.projected_free_after_minor");
          if (array(metrics.cashflow) && metrics.cashflow.every(plain)) {
            const payments = metrics.cashflow.filter(row => row.kind === "PAYMENT"), due = state.purposes.filter(purpose => purpose.remaining_due_minor > 0);
            if (payments.length !== due.length || payments.some(row => !due.some(purpose => purpose.purpose_id === row.event_id)) || due.some(purpose => {
              const linked = payments.filter(row => row.event_id === purpose.purpose_id), covered = coveredBy(purpose), amount = BigInt(purpose.remaining_due_minor), release = covered < amount ? covered : amount;
              return linked.length !== 1 || !number(linked[0].amount_minor) || BigInt(linked[0].amount_minor) !== -amount || !number(linked[0].release_minor ?? 0) || BigInt(linked[0].release_minor || 0) !== release || linked[0].at !== (purpose.due_at || purpose.due_date);
            })) add("RESULT_METRIC_INCONSISTENT", "日期路径的付款与拟议保护用途的义务、占用释放或日期不一致。", "metrics.cashflow");
            const opening = metrics.cashflow[0], actions = metrics.cashflow.filter(row => row.kind === "ACTION");
            if (plain(opening) && number(opening.balance_minor) && actions.every(row => number(row.amount_minor)) && number(metrics.projected_available_after_minor) && BigInt(opening.balance_minor) + actions.reduce((total, row) => total + BigInt(row.amount_minor), 0n) !== BigInt(metrics.projected_available_after_minor)) add("RESULT_METRIC_INCONSISTENT", "现金流起点及拟议动作与拟议可结算现金不一致。", "metrics.cashflow");
          }
        }
      }
    }
    if (result.preflight_eligible === true && (result.decision !== "ALLOW" || result.gate !== "READY_FOR_PAPER")) add("RESULT_STATUS_INCONSISTENT", "执行预检资格与风险或门禁状态不一致。", "preflight_eligible");
    return finish();
  } catch { add("RESULT_VALIDATION_FAILED", "结果核验未能完成，不能采用该结果。", "result"); return finish(); }
}
module.exports = { validateDailyResult, plain, definitions, softCodes };
