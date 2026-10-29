"use strict";
const { normalizeMoney } = require("./money.cjs");
const FIELDS = ["cash_yuan", "amount_yuan", "fees_yuan", "holds_yuan", "floor_yuan", "purpose_yuan", "due_yuan", "due_date", "purpose_label", "facts_confirmed", "purpose_confirmed"];

class ConversationError extends Error {
  constructor(code, message, status = 422) { super(message); this.name = "ConversationError"; this.code = code; this.status = status; this.execution_allowed = false; }
}
function reject(code, message, status) { throw new ConversationError(code, message, status); }
function money(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") reject("INVALID_MONEY_TEXT", "金额须保留原始十进制文本或明确的未知值。");
  return normalizeMoney({ amount: value, unit: "YUAN", currency: "CNY" }).amount_minor;
}
function normalizeConversationFinance(value, now = new Date().toISOString()) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !FIELDS.includes(key))) reject("UNTRUSTED_CONTROL_FIELD", "资金核对区只接受业务资料，不能提交权限、审批或风险结论。");
  for (const key of ["facts_confirmed", "purpose_confirmed"]) if (typeof value[key] !== "boolean") reject("CONFIRMATION_REQUIRED", "请分别确认资金事实和保护用途。");
  let due = value.due_date || null;
  if (due !== null && (typeof due !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(due) || !Number.isFinite(Date.parse(due)) || new Date(`${due}T00:00:00Z`).toISOString().slice(0, 10) !== due)) reject("INVALID_DUE_DATE", "付款日须为有效日期。");
  const label = value.purpose_label || "待确认的必要支出";
  if (typeof label !== "string" || !label.trim() || label.length > 60) reject("INVALID_PURPOSE_LABEL", "用途名称应为1至60字。");
  const floor = money(value.floor_yuan);
  return { contract_version: "conversation-finance.v1", data_mode: "SYNTHETIC_REPLAY",
    snapshot: { currency: "CNY", cash_ledger_minor: money(value.cash_yuan), as_of: now,
      purposes: [{ purpose_id: "conversation-protected-purpose", label: label.trim(), reserved_now_minor: money(value.purpose_yuan), remaining_due_minor: money(value.due_yuan), due_at: due }],
      hard_floor: { state: floor === null ? "UNKNOWN" : floor === 0 ? "DISABLED_CONFIRMED" : "ENABLED_CONFIRMED", amount_minor: floor }, income_events: [] },
    action: { type: "INVESTMENT", amount_minor: money(value.amount_yuan), fees_minor: money(value.fees_yuan), at: now },
    facts_confirmed: value.facts_confirmed, purposes_confirmed: value.purpose_confirmed, existing_holds_minor: money(value.holds_yuan) };
}
module.exports = { ConversationError, reject, normalizeConversationFinance };
