import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

// Package integrity checks only. No policy engine, model, network or financial call.
const directory = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(directory, "../../..");
let checks = 0;
function check(condition, label) {
  if (!condition) throw new Error(label);
  checks += 1;
}
const readJson = name => JSON.parse(fs.readFileSync(path.join(directory, name), "utf8"));
const policy = readJson("risk-policy.json");
const permissions = readJson("permission-matrix.json");
const catalog = readJson("reference-catalog.json");
const casebook = readJson("acceptance-cases.json");
const sameSet = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
const ids = catalog.sources.map(source => source.id);
const sourceIds = new Set(ids);

function validatePolicy(value) {
  check(value.policy_version === "risk-policy.v1.0", "Risk policy version changed");
  check(value.runtime_enabled === false && value.real_execution_enabled === false, "Specification must not enable execution");
  check(value.calibration_status === "NOT_CALIBRATED_FOR_REAL_USERS", "Calibration status must be explicit");
  check(sameSet(value.business_bands.map(item => item.code), ["LOW", "NOTICE", "ELEVATED", "HIGH", "UNKNOWN"]), "Business bands mismatch");
  check(value.business_bands.find(item => item.code === "UNKNOWN").severity_rank === null, "Unknown cannot be a low numeric score");
  check(sameSet(value.fixed_rules.map(item => item.id), Array.from({ length: 10 }, (_, i) => `R${String(i + 1).padStart(2, "0")}`)), "Fixed rules mismatch");
  for (const record of [...value.fixed_rules, ...value.dimensions]) {
    for (const id of record.sources) check(sourceIds.has(id), `Unknown source ${id}`);
  }
  const limits = value.financial_thresholds;
  check(limits.regulatory_thresholds === false && limits.hard_limit_comparator === "GT", "Threshold authority/comparator changed");
  check(limits.single_asset_max.total_assets === 0.35 && limits.single_asset_max.invested_assets === 0.50, "Single limits changed");
  check(limits.top_three_max.total_assets === 0.75 && limits.top_three_max.invested_assets === 0.90, "Top-three limits changed");
  check(limits.industry_max.total_assets === 0.40 && limits.industry_max.invested_assets === 0.60, "Industry limits changed");
  check(limits.pair_correlation_review.correlation_min_inclusive === 0.8 && limits.pair_correlation_review.pair_weight_total_assets_min_exclusive === 0.4, "Correlation limits changed");
  check(value.gradual_improvement.unknown_may_prove_improvement === false && value.gradual_improvement.core_acceptance_transition_implemented === false, "Review boundary changed");
  check(value.state_boundaries.callback_mapping.ERROR === null && value.state_boundaries.unresolved_review_execution_allowed === false, "Error/review cannot authorize execution");
  check(value.state_boundaries.not_run_risk_decision === null, "Not-run risk must remain separate");
}
validatePolicy(policy);

check(catalog.counts.total === 24 && sourceIds.size === 24 && ids.length === 24, "Catalog count/uniqueness");
for (const [prefix, count] of [["G", 7], ["D", 8], ["P", 6], ["T", 3]]) {
  for (let i = 1; i <= count; i += 1) check(sourceIds.has(`${prefix}${String(i).padStart(2, "0")}`), "Missing catalog entry");
}
for (const source of catalog.sources) {
  check(new URL(source.url).protocol === "https:", `${source.id} URL`);
  check(source.checked_at === "2026-10-29" && source.license && source.access_status, `${source.id} metadata`);
  check(Array.isArray(source.allowed_use) && source.allowed_use.length > 0 && Array.isArray(source.not_for) && source.not_for.length > 0, `${source.id} use boundaries`);
}
check(catalog.external_full_datasets_downloaded === false && catalog.model_trained === false && catalog.private_database_read === false, "Import/training claims changed");

const assets = catalog.sources.find(source => source.id === "D01").subassets;
check(assets.length === 3, "Qiqi asset count");
for (const asset of assets) {
  check(/^[a-f0-9]{40}$/.test(asset.ref), "Pinned source ref required");
  const bytes = execFileSync("git", ["show", `${asset.ref}:${asset.path}`], { cwd: repository, maxBuffer: 4 * 1024 * 1024 });
  check(crypto.createHash("sha256").update(bytes).digest("hex") === asset.git_blob_sha256, `${asset.id} content digest`);
  check(bytes.length === asset.byte_length, `${asset.id} byte length`);
  const blobId = execFileSync("git", ["rev-parse", `${asset.ref}:${asset.path}`], { cwd: repository, encoding: "utf8" }).trim();
  check(blobId === asset.git_blob_oid && asset.raw_content_copied === false, `${asset.id} Git provenance`);
  if (asset.id === "D01-BRIEF") {
    const rows = bytes.toString("utf8").trim().split(/\r?\n/).map(JSON.parse);
    check(rows.length === asset.row_count && new Set(rows.map(row => row.id)).size === asset.unique_ids, "Brief row/id profile");
    check(new Set(rows.map(row => row.date)).size === asset.dates.count, "Brief date profile");
    check(rows.filter(row => !row.decision?.team_answer).length === asset.quality_findings.team_answer_missing_count, "Brief answers are not labels");
  } else if (asset.id === "D01-PRICES") {
    const data = JSON.parse(bytes.toString("utf8"));
    check(Object.keys(data).length === asset.series_count && asset.dates === null, "Price series/date profile");
    for (const [code, series] of Object.entries(data)) {
      check(series.length === asset.series_profile[code].row_count && series.every(number => Number.isFinite(number) && number > 0), `Price values ${code}`);
    }
    check(asset.quality_findings.cross_asset_date_alignment_verified === false, "Missing dates cannot prove alignment");
  } else if (asset.id === "D01-NAV") {
    const data = JSON.parse(bytes.toString("utf8"));
    check(data.dates.length === asset.row_count && data.navs.length === asset.row_count, "NAV count");
    check(data.dates[0] === asset.dates.min && data.dates.at(-1) === asset.dates.max, "NAV date bounds");
    check(data.dates.every((date, i) => i === 0 || date > data.dates[i - 1]), "NAV dates ordered");
    check(asset.instrument_id_from_filename === "000001.OF", "Fund/stock identity separation");
  }
}

check(permissions.compatible_risk_policy_version === policy.policy_version, "Permission/risk version mismatch");
check(permissions.policy_version === casebook.permission_policy_version && casebook.policy_version === policy.policy_version, "Casebook versions mismatch");
check(permissions.implementation_status === "SPECIFICATION_ONLY" && permissions.live_execution_enabled === false, "Permission implementation state");
check(sameSet(permissions.levels.map(level => level.id), ["L0", "L1", "L2", "L3", "L4"]), "Permission levels");
check(permissions.levels.find(level => level.id === "L4").always_deny === true, "L4 must always deny");
check(permissions.paper_write_gates.currently_available === false && permissions.paper_write_gates.review_acceptance_protocol_available === false, "Unified paper/review gates must remain closed");
check(permissions.cleanup_and_reconciliation.no_new_investment_or_transfer === true, "Cleanup cannot authorize new investment");
check(permissions.non_inheritance.higher_level_does_not_grant_lower_level_resources === true, "No implicit level inheritance");
check(permissions.capabilities.length === 22 && new Set(permissions.capabilities.map(item => item.id)).size === 22, "Capability count/uniqueness");
for (const capability of permissions.capabilities) {
  check(capability.automatic_inheritance === false && capability.current_capability.runtime_available !== true, `${capability.id} runtime/inheritance`);
  check(["subject", "resource", "action", "purpose", "audience", "environment", "validity", "versions"].every(key => capability.scope[key]), `${capability.id} scope`);
  check(capability.confirmation_type && capability.enforcement.primary_owner && capability.recovery.length > 0, `${capability.id} enforcement/recovery`);
}

const schema = JSON.parse(fs.readFileSync(path.join(repository, "chenchen/contracts/risk-handoff.v1.schema.json"), "utf8")).$defs.CallbackRequest;
check(schema.additionalProperties === false && sameSet(policy.state_boundaries.callback_required_fields, schema.required), "Frozen callback fields mismatch");
check(sameSet(permissions.compatibility.risk_callback_required_fields, schema.required), "Permission callback fields mismatch");
check(sameSet(schema.properties.decision.enum, ["APPROVE", "REJECT", "REQUEST_MORE_INFO"]), "Frozen callback outcomes mismatch");
check(casebook.status === "EVALUATION_DESIGNS_NOT_EXECUTED" && casebook.application_tests_run === false, "Cases must not be reported as passed");
check(casebook.cases.length === 30 && new Set(casebook.cases.map(item => item.case_id)).size === 30, "Case count/uniqueness");
for (const item of casebook.cases) {
  check(item.status === "NOT_RUN" && item.fixture_authority === "SYNTHETIC_NOT_REAL_ACCOUNT_OR_APPROVAL", `${item.case_id} provenance`);
  check(item.expected.runtime_execution_enabled === false && policy.business_bands.some(band => band.code === item.expected.business_risk_band), `${item.case_id} band/runtime`);
  check(item.expected.risk_decision === null || policy.state_boundaries.risk_decisions.includes(item.expected.risk_decision), `${item.case_id} risk outcome`);
  check(item.expected.rule_refs.every(id => policy.fixed_rules.some(rule => rule.id === id)), `${item.case_id} rule links`);
}
const getCase = id => casebook.cases.find(item => item.case_id === id);
check(1800000 - 1300000 - 800000 === -300000 && getCase("UC02").expected.shortfall_minor === 300000, "Funding shortfall arithmetic");
check(1800000 - 400000 - 900000 === getCase("UC28").expected.free_cash_minor, "Linked hold must not be double-counted");
check(350000 / 1000000 === 0.35 && 350000 / 700000 === 0.5 && getCase("UC06").expected.risk_decision === "ALLOW", "Threshold equality boundary");
check(250000 / 400000 > 0.5 && getCase("UC07").expected.risk_decision === "BLOCK", "Dual-denominator boundary");
check(getCase("UC14").expected.risk_decision === "ALLOW" && getCase("UC15").expected.risk_decision === "REVIEW", "Correlation weight boundary");
check(getCase("UC16").expected.risk_decision === "BLOCK" && getCase("UC16").expected.coverage === "PARTIAL" && getCase("UC16").expected.check_errors.length > 0, "Block plus error must retain both");
check(getCase("UC17").expected.risk_engine_ran === false && getCase("UC17").expected.risk_decision === null, "Entry denial is not an Engine BLOCK");
check(getCase("UC05").given.risk_gate_requested === true && getCase("UC26").expected.risk_check_state === "NOT_REQUESTED", "Cash-plan check and diagnosis scopes differ");
check(casebook.synthetic_baselines.common_context.amount_unit === "INTEGER_MINOR" && casebook.synthetic_baselines.common_context.cash_basis === "GROSS_SETTLED_LEDGER_CASH_INCLUDING_HOLDS", "Synthetic unit and balance basis must be explicit");
for (const id of ["UC03", "UC04", "UC27"]) check(getCase(id).remove_baseline_fields.includes("gross_cash_minor"), `${id} must not inherit known cash`);
check(getCase("UC28").given.active_holds[0].obligation_id === casebook.synthetic_baselines.protected_cashflow.protected_obligations[0].obligation_id, "Hold and rent must share an obligation identity");
check(getCase("UC21").given.receipt_and_assessment_bind_same_subject_account_task_and_proposal === true && getCase("UC21").given.original_assessment_coverage === "FULL", "Receipt cannot invent a prior assessment");
for (const id of ["UC19", "UC21", "UC24"]) check(getCase(id).expected.risk_decision_source === "ORIGINAL_VERSION_BOUND_ASSESSMENT", `${id} must identify the previous risk record`);
for (const item of casebook.cases.filter(item => item.expected.risk_decision === null)) check(policy.state_boundaries.not_run_context_states.includes(item.expected.risk_check_state), `${item.case_id} null reason`);
for (const capability of permissions.capabilities) check(capability.on_denial.starts_new_risk_check === false && !Object.hasOwn(capability.on_denial, "risk_engine_ran"), `${capability.id} denial must not rewrite prior Risk history`);

// Exercise validator rejection without changing files or running business logic.
let invalidConfigurationsRejected = 0;
for (const mutate of [
  value => { value.runtime_enabled = true; },
  value => { value.financial_thresholds.single_asset_max.total_assets = 0.99; },
  value => { value.fixed_rules[0].sources = ["UNREGISTERED_SOURCE"]; },
  value => { value.state_boundaries.callback_mapping.ERROR = "APPROVE"; }
]) {
  const invalid = structuredClone(policy);
  mutate(invalid);
  let rejected = false;
  try { validatePolicy(invalid); } catch { rejected = true; }
  check(rejected, "Invalid configuration was accepted");
  invalidConfigurationsRejected += 1;
}

const documents = ["README.md", "../权限分级与授权闭环策划-v0.1.md", "../项目进度同步-2026-10-29.md", "../research/金融风控参考调研-2026-10-29.md"];
for (const file of documents) {
  const absolute = path.resolve(directory, file);
  const text = fs.readFileSync(absolute, "utf8");
  check(!text.includes("\uFFFD") && text.endsWith("\n"), `${file} text encoding`);
  check((text.match(/^```/gm) || []).length % 2 === 0, `${file} fenced blocks`);
  let columns = null;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("|")) {
      const count = line.split("|").length;
      if (columns === null) columns = count;
      check(count === columns, `${file} table columns`);
    } else columns = null;
  }
  for (const link of text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    if (!/^https?:/.test(link[1])) check(fs.existsSync(path.resolve(path.dirname(absolute), link[1])), `${file} local link ${link[1]}`);
  }
}

console.log(JSON.stringify({
  scope: "SPECIFICATION_PACKAGE_CHECKS_ONLY",
  checks_passed: checks,
  invalid_configurations_rejected: invalidConfigurationsRejected,
  reference_entries: ids.length,
  qiqi_snapshot_digests_verified: assets.length,
  capability_entries: permissions.capabilities.length,
  acceptance_case_designs: casebook.cases.length,
  application_cases_run: 0,
  model_calls: 0,
  runtime_integration: false,
  joint_acceptance: false
}, null, 2));
