"use strict";
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { makeFixture } = require("./fixture-data.cjs");
const { buildRiskCallbackDraft, ADAPTER_VERSION } = require("./risk-callback.cjs");
const { normalizeMoney, minorToYuan, minorToYuanNumber } = require("./money.cjs");
const directory = path.resolve(__dirname, "../../../docs/safety-risk-eval/interface-adapters-v1/examples");
const check = process.argv.includes("--check");
function file(name, data) {
  const output = JSON.stringify(data, null, 2) + "\n", target = path.join(directory, name);
  if (check) assert.deepEqual(JSON.parse(fs.readFileSync(target, "utf8")), data, `Example drift: ${name}`);
  else { fs.mkdirSync(directory, { recursive: true }); fs.writeFileSync(target, output); }
}
for (const decision of ["ALLOW", "REVIEW", "BLOCK", "ERROR"]) {
  const input = makeFixture(decision), output = buildRiskCallbackDraft(input);
  file(`${decision.toLowerCase()}.input.json`, input); file(`${decision.toLowerCase()}.output.json`, output);
}
const cases = [
  { amount: "0.01", unit: "YUAN", currency: "CNY" }, { amount: 0.1, unit: "YUAN", currency: "CNY" },
  { amount: "8000.00", unit: "YUAN", currency: "CNY" }, { amount: null, unit: "YUAN", currency: "CNY" },
  { amount: 800000, unit: "MINOR", currency: "CNY" }, { amount: "10000000000.00", unit: "YUAN", currency: "CNY" },
  { amount: "1.005", unit: "YUAN", currency: "CNY" }, { amount: "1.000", unit: "YUAN", currency: "CNY" },
  { amount: 0.1 + 0.2, unit: "YUAN", currency: "CNY" }, { amount: "10000000000.01", unit: "YUAN", currency: "CNY" },
  { amount: 1, unit: "UNKNOWN", currency: "CNY" }, { amount: 1, unit: "YUAN", currency: "USD" }
].map(input => {
  try { const normalized = normalizeMoney(input); return { input, normalized, exact_yuan_decimal: minorToYuan(normalized.amount_minor), compatible_yuan_number: minorToYuanNumber(normalized.amount_minor) }; }
  catch (error) { return { input, error_code: error.code }; }
});
file("money-vectors.json", { fixture: true, amount_unit_required: true, cases });
file("manifest.json", {
  adapter_version: ADAPTER_VERSION, status: "MODULE4_PROPOSAL_PENDING_TEAM_REVIEW", fixture: true,
  real_model_called: false, account_verified: false, callback_sent: false, execution_authorized: false,
  notice_zh: "全部为虚构契约样例。call_succeeded等模型字段属于测试替身，不代表真实模型调用或签名验证。ERROR样例callback为null。",
  core_source_commit: "23a978e", cases: ["allow", "review", "block", "error"].map(name => ({ input: `${name}.input.json`, output: `${name}.output.json` })), money_vectors: "money-vectors.json"
});
console.log(JSON.stringify({ mode: check ? "CHECKED" : "GENERATED", callback_cases: 4, money_cases: cases.length, files: 10, directory }));
