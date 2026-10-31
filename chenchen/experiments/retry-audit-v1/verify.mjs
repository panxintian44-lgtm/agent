import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import worker, { ReviewService } from "../../deployment/worker.js";
import bridge from "../../integrations/owner-bridge.js";
import exporter from "../../scripts/export-review-evidence.js";

const argument = process.argv.indexOf("--output-dir");
if (argument < 0 || !process.argv[argument + 1]) throw new Error("--output-dir <new evidence directory> required");
const output = path.resolve(process.argv[argument + 1]);
fs.mkdirSync(output);
const rows = new Map(), transport = [], cases = []; let calls = 0, failProvider = false;
const env = { MODEL_PROVIDER: "workers_ai", MODEL_MAX_ATTEMPTS: "1", MODEL_REQUESTS_PER_MINUTE: "100",
  MODEL_DISABLE_RULE_FALLBACK: "true", RATE_LIMIT_PER_MINUTE: "0", REQUIRE_TRUSTED_ACTORS: "true",
  RISK_SERVICE_HMAC_SECRET: randomBytes(32).toString("hex"), APPROVAL_SERVICE_HMAC_SECRET: randomBytes(32).toString("hex"),
  RISK_REVIEWER_ID: "synthetic-risk-reviewer",
  AI: { run: async () => { calls++; if (failProvider) throw new Error("SYNTHETIC_PROVIDER_FAILURE");
    return { id: "synthetic-vendor-response-" + calls, response: { summary: "虚构案例：投资前保留房租用途。", risk_level: "unknown",
      proposed_action: "HOLD_FOR_REVIEW", action_reason: "仅为模型替身提议，等待风控与人工审批。", missing_information: ["正式账户数据"], evidence: ["虚构房租安排"] } }; } } };
const storage = { get: async key => structuredClone(rows.get(key)), put: async entries => {
  for (const [key, value] of Object.entries(entries)) rows.set(key, structuredClone(value));
} };
let service = new ReviewService({ storage }, env);
env.REVIEW_SERVICE = { idFromName: name => name, get: () => service };
async function call(endpoint, body, owner = null, { signedBody = body, signed = true } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (owner && signed) headers[owner === "risk" ? "X-Risk-Signature" : "X-Approval-Signature"] =
    await bridge.signatureFor(signedBody, env[owner === "risk" ? "RISK_SERVICE_HMAC_SECRET" : "APPROVAL_SERVICE_HMAC_SECRET"]);
  const response = await worker.fetch(new Request("https://synthetic-local.test" + endpoint, body === undefined ? {} : {
    method: "POST", headers, body: JSON.stringify(body)
  }), env);
  const result = await response.json();
  transport.push({ endpoint, method: body === undefined ? "GET" : "POST", request: body ?? null,
    signed_request: Boolean(owner && signed), signature_material_exported: false, status: response.status, response: result });
  return { status: response.status, body: result };
}
async function start(name) {
  const response = await call("/api/review/legacy", { question: "虚构案例：手上有一万元，预留房租后考虑投资。案例 " + name, idempotency_key: "retry-audit-" + name });
  assert.equal(response.status, 200);
  return (await call("/api/review/task/" + response.body.task_id)).body;
}
const executionInput = record => ({ task_id: record.task_id, proposal_sha256: record.proposed_action.proposal_sha256 });
const riskCallback = (record, decision) => ({ callback_version: "risk-callback.v1", handoff_id: record.risk_handoff.handoff_id,
  task_id: record.task_id, request_id: record.request_id, run_id: record.run_id, audit_id: record.audit.audit_id,
  proposal_sha256: record.proposed_action.proposal_sha256, decision, reviewer: "synthetic-risk-reviewer", reason: "本地签名通道试验，非正式 Risk 服务判定" });
const approval = record => ({ ...executionInput(record), decision: "APPROVE", approver: "synthetic-human", reason: "虚构人工确认，仅限 PAPER" });
async function saveCase(name, record, checks) {
  const inputFile = path.join(output, name + ".json");
  fs.writeFileSync(inputFile, JSON.stringify(record, null, 2) + "\n", { flag: "wx" });
  const result = exporter.exportFile(inputFile, path.join(output, name), { includeContent: true });
  assert.equal(result.consistency_status, "CONSISTENT_WITH_LIMITS", JSON.stringify(result.findings));
  cases.push({ name, task_id: record.task_id, status: record.status, audit_id: record.audit.audit_id,
    exported_events: result.event_count, checks, content: "SYNTHETIC_ONLY", export_manifest: name + "/manifest.json" });
}

const approved = await start("approved");
assert.equal((await call("/api/review/simulate", executionInput(approved))).status, 409);
const callback = riskCallback(approved, "APPROVE");
assert.equal((await call("/api/review/risk-callback", callback, "risk", { signed: false })).status, 401);
assert.equal((await call("/api/review/risk-callback", { ...callback, reason: "changed after signing" }, "risk", { signedBody: callback })).status, 401);
assert.equal((await call("/api/review/risk-callback", callback, "risk")).body.callback_status, "RECORDED");
assert.equal((await call("/api/review/risk-callback", callback, "risk")).body.callback_status, "DUPLICATE");
assert.equal((await call("/api/review/simulate", executionInput(approved))).status, 409);
assert.equal((await call("/api/review/approval", approval(approved), "approval", { signed: false })).status, 401);
assert.equal((await call("/api/review/approval", approval(approved), "approval")).status, 200);
assert.equal((await call("/api/review/simulate", { ...executionInput(approved), amount: 8000 })).status, 409);
const first = await call("/api/review/simulate", executionInput(approved)); assert.equal(first.status, 200);
service = new ReviewService({ storage }, env);
const replay = await call("/api/review/simulate", executionInput(approved)); assert.equal(replay.status, 200);
assert.deepEqual(replay.body.execution.receipt, first.body.execution.receipt);
await saveCase("approved", replay.body, ["NO_RISK_BLOCKED", "UNSIGNED_REJECTED", "TAMPERED_SIGNATURE_REJECTED", "CALLBACK_REPLAY", "NO_APPROVAL_BLOCKED", "CHANGED_ACTION_BLOCKED", "PAPER_RECEIPT_REPLAY_AFTER_RESTART"]);

const rejected = await start("rejected");
assert.equal((await call("/api/review/risk-callback", riskCallback(rejected, "REJECT"), "risk")).status, 200);
assert.equal((await call("/api/review/approval", approval(rejected), "approval")).status, 409);
assert.equal((await call("/api/review/simulate", executionInput(rejected))).status, 409);
await saveCase("rejected", (await call("/api/review/task/" + rejected.task_id)).body, ["REJECTION_TERMINAL"]);

const waiting = await start("waiting");
const dispatch = await call("/api/review/risk-dispatch", executionInput(waiting));
assert.equal(dispatch.status, 503); assert.equal(dispatch.body.error.code, "RISK_OWNER_NOT_CONFIGURED");
await saveCase("waiting", (await call("/api/review/task/" + waiting.task_id)).body, ["FORMAL_GATEWAY_STILL_REQUIRED"]);

const expired = await start("expired");
await call("/api/review/risk-callback", riskCallback(expired, "APPROVE"), "risk");
const confirmed = (await call("/api/review/approval", approval(expired), "approval")).body;
assert.equal(confirmed.status, "READY_FOR_SIMULATION");
confirmed.approval.expires_at = "2000-01-01T00:00:00.000Z";
await storage.put({ ["run:" + confirmed.run_id]: confirmed });
assert.equal((await call("/api/review/simulate", executionInput(expired))).body.error.code, "APPROVAL_EXPIRED");
await saveCase("expired", (await call("/api/review/task/" + expired.task_id)).body, ["EXPIRED_APPROVAL_BLOCKED", "TEST_STORAGE_DEADLINE_INJECTION"]);

failProvider = true;
const failure = await call("/api/review/legacy", { question: "虚构供应商失败案例", idempotency_key: "retry-audit-provider-failure" });
assert.equal(failure.status, 502);
failProvider = false;
await saveCase("model-failed", (await call("/api/review/task/" + failure.body.trace.task_id)).body, ["MODEL_FAILURE_VISIBLE_NO_FALLBACK"]);

const report = { report_version: "retry-audit-local.v1", recorded_at: new Date().toISOString(), status: "LOCAL_SIGNED_PATH_VERIFIED",
  deployed_worker_handler_used: true, actual_risk_owner_rules_used: false, risk_and_approval_decisions: "SYNTHETIC_TEST_FIXTURES",
  storage: "IN_MEMORY_DURABLE_OBJECT_TEST_ADAPTER", synthetic_provider_calls: calls, external_model_calls: 0, paid_model_calls: 0,
  network_transport: "IN_PROCESS_REQUEST_RESPONSE", real_user_identity_tested: false, formal_callback_connected: false,
  public_handoff_schema_status: "KNOWN_BLOCKER_NOT_CHANGED", joint_acceptance: false, cases, transport };
fs.writeFileSync(path.join(output, "verification.json"), JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
console.log(JSON.stringify({ status: report.status, cases: cases.length, synthetic_provider_calls: calls,
  external_model_calls: 0, paid_model_calls: 0, joint_acceptance: false }));
