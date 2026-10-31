"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { execFileSync } = require("node:child_process");

const here = __dirname;
const root = path.resolve(here, "../../..");
const candidate = process.argv[2];
if (!/^[a-f0-9]{40}$/.test(candidate || "")) throw new Error("Provide the complete tested code candidate SHA.");
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true }).trim();
const runtimeChanges = git("diff", "--name-only", candidate, "--", "chenchen", "modules/safety-risk-eval");
if (runtimeChanges) throw new Error("Runtime sources differ from the tested code candidate: " + runtimeChanges);
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const read = file => fs.readFileSync(path.join(here, file));
const json = file => JSON.parse(read(file).toString("utf8"));
function tap(file, allowFailures = false) {
  const bytes = read(file), text = bytes.toString("utf8");
  const count = field => {
    const match = text.match(new RegExp("^# " + field + " (\\d+)\\r?$", "m"));
    if (!match) throw new Error("Missing TAP summary: " + file + " / " + field);
    return Number(match[1]);
  };
  const value = { file, sha256: sha256(bytes), tests: count("tests"), passed: count("pass"), failed: count("fail"), skipped: count("skipped") };
  if (!allowFailures && value.failed) throw new Error("Failing verification: " + file);
  if (value.tests !== value.passed + value.failed + value.skipped) throw new Error("Inconsistent TAP summary: " + file);
  return value;
}
const http = json("current-candidate-http.json");
if (http.failed || http.passed !== 18 || http.formal_joint_acceptance || http.real_model_calls || http.real_financial_operations) throw new Error("HTTP evidence has an unexpected scope or failed case.");
const build = json("cloud-build-manifest.json");
if (build.source_commit !== candidate || build.source_dirty || !build.release_eligible) throw new Error("Cloud build must come from the committed code candidate.");
const cloudBundle = fs.readFileSync(path.join(root, "modules/safety-risk-eval/cloudflare/dist/risk-worker.mjs"));
if (sha256(cloudBundle) !== build.bundle_sha256) throw new Error("Cloud bundle digest mismatch.");
const rawFiles = ["baseline-core-tests.tap", "trusted-reviewer-before.tap", "trusted-reviewer-tests.tap", "cloud-queue-before.tap", "cloud-queue-tests.tap", "core-tests.tap", "core-check.txt", "risk-tests.tap", "cloud-tests.tap", "current-candidate-http.json", "cloud-build-manifest.json", "wrangler-dry-run.txt", "examples-check.json", "live-readonly-probes.json"];
const sources = ["chenchen/integrations/owner-bridge.js", "chenchen/deployment/worker.js", "chenchen/integrations/review-workflow.js", "chenchen/integrations/review-reservation.js", "modules/safety-risk-eval/interface-adapters/risk-callback-sender.cjs", "modules/safety-risk-eval/cloudflare/worker.mjs", "modules/safety-risk-eval/cloudflare/store.mjs", "modules/safety-risk-eval/cloudflare/build.mjs", "modules/safety-risk-eval/joint-acceptance/current-candidate-http.cjs"];
const report = {
  report_version: "risk-trusted-handoff-verification.v1", generated_at: new Date().toISOString(),
  base_integration_sha: "75dcfa269f63ef2fe81394277a0ce537b4feb9aa", tested_code_candidate_sha: candidate,
  report_parent_sha: git("rev-parse", "HEAD"), runtime_changes_since_candidate: [],
  environment: { platform: process.platform, node: process.version, ajv: require(path.join(root, "modules/safety-risk-eval/interface-adapters/node_modules/ajv/package.json")).version },
  baseline_core: tap("baseline-core-tests.tap"), trusted_reviewer_before: tap("trusted-reviewer-before.tap", true),
  trusted_reviewer_after: tap("trusted-reviewer-tests.tap"), core: tap("core-tests.tap"), risk: tap("risk-tests.tap"), cloud: tap("cloud-tests.tap"),
  local_http: { file: "current-candidate-http.json", passed: http.passed, failed: http.failed, scope: http.scope, cases: http.cases.map(row => ({ case_id: row.case_id, result: row.result })) },
  cloud_build: { source_commit: build.source_commit, source_dirty: build.source_dirty, release_eligible: build.release_eligible, source_files: Object.keys(build.source_files_sha256).length, bundle_sha256: build.bundle_sha256, toolchain: build.toolchain },
  source_files: sources.map(file => ({ path: file, sha256: sha256(fs.readFileSync(path.join(root, file))), git_blob: git("rev-parse", candidate + ":" + file) })),
  evidence_files: rawFiles.map(file => ({ path: file, sha256: sha256(read(file)) })),
  commands: [
    "node --test --test-reporter=tap chenchen/tests/trusted-risk-reviewer.test.mjs",
    "cd chenchen && node --test --test-reporter=tap",
    "cd chenchen && npm run check",
    "node --test --test-reporter=tap modules/safety-risk-eval/unified-rating/test/*.test.cjs modules/safety-risk-eval/interface-adapters/test/*.test.cjs modules/safety-risk-eval/network-resilience/test/*.test.cjs modules/safety-risk-eval/network-resilience/test/*.test.mjs modules/safety-risk-eval/joint-acceptance/test/*.test.cjs",
    "node modules/safety-risk-eval/joint-acceptance/current-candidate-http.cjs --out <report.json>",
    "npm --prefix modules/safety-risk-eval/cloudflare run build",
    "node --test --test-reporter=tap modules/safety-risk-eval/cloudflare/test/*.test.mjs",
    "node modules/safety-risk-eval/interface-adapters/write-examples.cjs --check",
    "git diff --check"
  ],
  limitations: ["LOCAL_PROGRAM_SQLITE_AND_LOOPBACK_HTTP_NOT_TEAM_STAGING", "MODEL_AND_APPROVAL_ARE_EXPLICIT_TEST_DOUBLES", "SERVICE_HMAC_IS_NOT_AUTHENTICATED_END_USER_APPROVAL", "CORE_FUNDING_DEMO_IS_NOT_SHARED_FINANCE_LEDGER", "CLOUD_ADAPTER_REVIEW_ONLY_NOT_CORE_PUSH_RECEIVER_OR_SIMULATION_GATEWAY", "CLOUDFLARE_CLI_NOT_AUTHENTICATED_NO_DEPLOYMENT"],
  ci: { workflow: ".github/workflows/risk-p0-candidate.yml", permissions: "contents:read", online_run_verified: false },
  staging: { core_deployment_id: null, risk_deployment_id: null, candidate_deployed: false, both_owner_signoff: false, formal_joint_acceptance: false, status: "NO_GO" },
  real_model_calls: 0, paid_model_calls: 0, real_financial_operations: 0, real_execution_enabled: false
};
fs.writeFileSync(path.join(here, "verification.json"), JSON.stringify(report, null, 2) + "\n");
process.stdout.write(JSON.stringify({ code_candidate: candidate, core: report.core, risk: report.risk, cloud: report.cloud, http: report.local_http.passed, staging_status: report.staging.status }) + "\n");
