"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const here = __dirname, root = path.resolve(here, "../../..");
const candidate = process.argv[2];
const upstream = "4f98bcfbb45e3d8522484f5b446e498abd7b1ed1";
const previousRisk = "e8f01cc5a77077f87fbabb891c0e51de21b9b6b6";
if (!/^[a-f0-9]{40}$/.test(candidate || "")) throw new Error("Provide the complete tested candidate SHA.");
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true }).trim();
git("merge-base", "--is-ancestor", upstream, candidate);
git("merge-base", "--is-ancestor", previousRisk, candidate);
if (git("diff", "--name-only", candidate, "--", "chenchen", "modules/safety-risk-eval", ".github")) throw new Error("Runtime sources changed since the tested candidate.");
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const read = name => fs.readFileSync(path.join(here, name));
const json = name => JSON.parse(read(name));
function tap(file) {
  const bytes = read(file), text = bytes.toString("utf8");
  const count = key => { const match = text.match(new RegExp("^# " + key + " (\\d+)\\r?$", "m")); if (!match) throw new Error("Missing TAP summary: " + file); return Number(match[1]); };
  const value = { file, sha256: digest(bytes), tests: count("tests"), passed: count("pass"), failed: count("fail"), skipped: count("skipped") };
  if (value.failed || value.tests !== value.passed + value.skipped) throw new Error("Failing or incomplete tests: " + file);
  return value;
}
const build = json("cloud-build-manifest.json"), http = json("current-candidate-http.json"), probes = json("live-readonly-probes.json");
if (build.source_commit !== candidate || build.source_dirty || !build.release_eligible) throw new Error("Cloud build is not the clean common candidate.");
if (digest(fs.readFileSync(path.join(root, "modules/safety-risk-eval/cloudflare/dist/risk-worker.mjs"))) !== build.bundle_sha256) throw new Error("Bundle digest mismatch.");
if (http.failed || http.passed !== 18 || http.source_manifest.git_head !== candidate || http.real_model_calls || http.formal_joint_acceptance) throw new Error("Unexpected HTTP evidence or source version.");
const liveCore = probes.observations.find(row => row.url.endsWith("/capabilities"))?.response;
const liveRisk = probes.observations.find(row => row.url.includes("risk-bridge"))?.response;
const states = {
  report_version: "core-risk-config-confirmation.v1", observed_at: probes.checked_at_utc,
  code_candidate_sha: candidate, secret_values_read: false, cross_service_signature_verification: "NOT_PERFORMED",
  fields: [
    { name: "RISK_REVIEWER_ID", code_contract: "FIXED_SERVICE_ID_1_TO_200_NO_PADDING_OR_CONTROL", core_online: "UNKNOWN", risk_online: "UNKNOWN", same_value_verified: false },
    { name: "RISK_SERVICE_HMAC_SECRET", code_contract: "STRICT_PRIMARY_NAME_REQUIRED", core_online: liveCore?.risk?.callback_signature_configured === false ? "NOT_CONFIGURED_SELF_REPORTED" : "UNKNOWN", risk_online: "UNKNOWN", same_value_verified: false },
    { name: "CORE_AGENT_API_KEY", code_contract: "SERVER_SIDE_MACHINE_AUTH_ONLY", core_online: "UNKNOWN", risk_online: "UNKNOWN", same_value_verified: false },
    { name: "REQUIRE_TRUSTED_ACTORS", code_contract: "TRUE_FOR_STAGING", core_online: "UNKNOWN", risk_online: "UNKNOWN", same_value_verified: false },
    { name: "REQUIRE_RISK_REVIEWER", code_contract: "TRUE_FOR_STAGING", core_online: "UNKNOWN", risk_online: "UNKNOWN", same_value_verified: false }
  ],
  public_risk_owner_source: liveRisk?.owner_source ?? "UNKNOWN",
  core_worker_version_id: null, risk_worker_version_id: null, core_deployment_id: null, risk_deployment_id: null,
  authenticated_end_user_approval: "NOT_VERIFIED", joint_acceptance: "NO_GO"
};
fs.writeFileSync(path.join(here, "config-status.json"), JSON.stringify(states, null, 2) + "\n");
const evidence = ["trusted-reviewer-tests.tap", "core-tests.tap", "risk-tests.tap", "cloud-tests.tap", "core-check.txt", "current-candidate-http.json", "cloud-build-manifest.json", "wrangler-dry-run.txt", "examples-check.json", "live-readonly-probes.json", "config-status.json"];
const sources = ["chenchen/integrations/owner-bridge.js", "chenchen/deployment/worker.js", "chenchen/integrations/review-workflow.js", "chenchen/integrations/review-reservation.js", "modules/safety-risk-eval/cloudflare/worker.mjs", "modules/safety-risk-eval/cloudflare/store.mjs", "modules/safety-risk-eval/cloudflare/build.mjs", "modules/safety-risk-eval/cloudflare/build-snapshot.mjs", "modules/safety-risk-eval/interface-adapters/risk-callback-sender.cjs"];
const result = {
  report_version: "core-risk-alignment-verification.v1", generated_at: new Date().toISOString(),
  upstream_core_sha: upstream, previous_risk_head: previousRisk, tested_code_candidate_sha: candidate,
  both_source_histories_retained: true, runtime_changes_since_candidate: [],
  environment: { platform: process.platform, node: process.version, ajv: require(path.join(root, "modules/safety-risk-eval/interface-adapters/node_modules/ajv/package.json")).version },
  tests: { trusted_reviewer: tap("trusted-reviewer-tests.tap"), core: tap("core-tests.tap"), risk: tap("risk-tests.tap"), cloud: tap("cloud-tests.tap"), http: { passed: http.passed, failed: http.failed, scope: http.scope } },
  cloud_build: { source_commit: build.source_commit, source_dirty: false, release_eligible: true, bundle_sha256: build.bundle_sha256, source_files: Object.keys(build.source_files_sha256).length, toolchain: build.toolchain },
  evidence_files: evidence.map(file => ({ path: file, sha256: digest(read(file)) })),
  source_files: sources.map(file => ({ path: file, sha256: digest(fs.readFileSync(path.join(root, file))), git_blob: git("rev-parse", candidate + ":" + file) })),
  historic_evidence_preserved_at: "docs/safety-risk-eval/p0-trusted-handoff-2026-10-31/",
  configuration_confirmation: "CODE_NAMES_AND_VALIDATION_ALIGNED_LIVE_BINDINGS_NOT_VERIFIED",
  model: "EXPLICIT_TEST_DOUBLE", approval: "SIGNED_SERVICE_TEST_DOUBLE_NOT_AUTHENTICATED_USER", storage: "LOCAL_SQLITE_AND_MEMORY_ADAPTERS_NOT_CLOUDFLARE_ACCEPTANCE",
  real_model_calls: 0, paid_model_calls: 0, real_financial_operations: 0, deployed: false,
  staging_urls_confirmed: false, deployment_sha_mapping_verified: false, both_owner_signoff: false,
  authenticated_end_user_approval_verified: false, shared_finance_ledger_verified: false, formal_joint_acceptance: false, status: "NO_GO"
};
fs.writeFileSync(path.join(here, "verification.json"), JSON.stringify(result, null, 2) + "\n");
process.stdout.write(JSON.stringify({ candidate, tests: result.tests, bundle: result.cloud_build.bundle_sha256, status: result.status }) + "\n");
