import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import worker, { ReviewService } from "../../../deployment/worker.js";
import bridge from "../../../integrations/owner-bridge.js";
import evidence from "../../../integrations/review-evidence.js";
import adapter from "./adapter.js";

const directory = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(fs.readFileSync(path.join(directory, "synthetic.json"), "utf8"));

export async function verifyAccountSummary({ input = fixture, synthetic = true, outputDirectory = null } = {}) {
  const report = adapter.reconcileAccountSummary(input);
  const transport = [], cases = [], captured = [];
  const rows = new Map();
  const env = {
    MODEL_PROVIDER: "workers_ai", MODEL_MAX_ATTEMPTS: "1", MODEL_REQUESTS_PER_MINUTE: "100", MODEL_DISABLE_RULE_FALLBACK: "true",
    RATE_LIMIT_PER_MINUTE: "0", REQUIRE_TRUSTED_ACTORS: "true", RISK_SERVICE_HMAC_SECRET: randomBytes(32).toString("hex"),
    APPROVAL_SERVICE_HMAC_SECRET: randomBytes(32).toString("hex"), RISK_REVIEWER_ID: "synthetic-risk-reviewer",
    AI: { run: async (_model, request) => {
      captured.push(structuredClone(request));
      return { id: "synthetic-account-summary-response-" + captured.length, response: {
        summary: "汇总数字只能局部核对，资料不足，不能确定完整持仓或可投资额度。", risk_level: "unknown", proposed_action: "REQUEST_MORE_INFO",
        action_reason: "本地模型替身固定响应；未经账户验证，不得执行。", missing_information: report.missing_information,
        evidence: ["未提供持仓明细、快照时间和可用资金定义"] } };
    } }
  };
  const storage = { get: async key => structuredClone(rows.get(key)), put: async entries => {
    for (const [key, value] of Object.entries(entries)) rows.set(key, structuredClone(value));
  } };
  let service = new ReviewService({ storage }, env);
  env.REVIEW_SERVICE = { idFromName: name => name, get: () => service };
  async function call(endpoint, body, expected, owner = null) {
    const headers = { "Content-Type": "application/json" };
    if (owner) headers[owner === "risk" ? "X-Risk-Signature" : "X-Approval-Signature"] =
      await bridge.signatureFor(body, env[owner === "risk" ? "RISK_SERVICE_HMAC_SECRET" : "APPROVAL_SERVICE_HMAC_SECRET"]);
    const response = await worker.fetch(new Request("https://account-summary.invalid" + endpoint, body === undefined ? {} : {
      method: "POST", headers, body: JSON.stringify(body)
    }), env);
    const result = await response.json();
    transport.push({ endpoint, method: body === undefined ? "GET" : "POST", request: body ?? null, signed_by_test_harness: Boolean(owner),
      signature_material_exported: false, status: response.status, response: result });
    assert.equal(response.status, expected, endpoint + ": " + JSON.stringify(result.error || result.status));
    return result;
  }
  for (const decision of ["REQUEST_MORE_INFO", "REJECT"]) {
    const request = adapter.buildReviewCandidate(input, { idempotencyKey: "account-summary-" + decision, synthetic });
    const created = await call("/api/review", request, 200);
    assert.equal(created.status, "PENDING_RISK");
    assert.equal(created.model.model_response.proposal.proposed_action, "REQUEST_MORE_INFO");
    assert.equal(created.model.model_response.provider_response_id, "synthetic-account-summary-response-" + captured.length);
    // Verify the data reached the model request, not only the persisted context.
    const modelUserMessage = captured.at(-1).messages.find(message => message.role === "user").content;
    const modelInput = JSON.parse(modelUserMessage.slice(modelUserMessage.indexOf("{")));
    assert.deepEqual(modelInput.context.account_summary_candidate, report);
    const callsBeforeReplay = captured.length;
    const duplicate = await call("/api/review", request, 200);
    assert.equal(duplicate.task_id, created.task_id);
    assert.equal(captured.length, callsBeforeReplay);
    const binding = { task_id: created.task_id, proposal_sha256: created.proposed_action.proposal_sha256 };
    assert.equal((await call("/api/review/simulate", binding, 409)).error.code, "EXECUTION_BLOCKED");
    assert.equal((await call("/api/review/risk-dispatch", binding, 503)).error.code, "RISK_OWNER_NOT_CONFIGURED");
    const handoff = await call("/api/review/task/" + created.task_id + "/risk-handoff", undefined, 200);
    for (const field of ["task_id", "request_id", "run_id"]) assert.equal(handoff[field], created[field]);
    assert.equal(handoff.audit_id, created.audit.audit_id);
    assert.equal(handoff.proposal.proposal_sha256, binding.proposal_sha256);
    assert.equal(handoff.input_authority, "UNVERIFIED_CALLER_INPUT");
    assert.deepEqual(handoff.reviewed_input.context.account_summary_candidate, report);
    assert.deepEqual(handoff.proposal.action_parameters, {});
    assert.equal(handoff.reviewed_input.memory_consent, false);
    assert.equal(handoff.reviewed_input.plan_id, null);
    assert.equal(handoff.reviewed_input.portfolio_snapshot_id, null);
    const callback = { callback_version: "risk-callback.v1", handoff_id: handoff.handoff_id, task_id: handoff.task_id,
      request_id: handoff.request_id, run_id: handoff.run_id, audit_id: handoff.audit_id,
      proposal_sha256: handoff.proposal.proposal_sha256, decision, reviewer: "synthetic-risk-reviewer", reason: "固定测试判定：汇总资料不足；非正式 Risk 服务结果" };
    const unsigned = await call("/api/review/risk-callback", callback, 401);
    assert.equal(unsigned.error.code, "OWNER_AUTH_REQUIRED");
    const decided = await call("/api/review/risk-callback", callback, 200, "risk");
    assert.equal(decided.workflow.status, decision === "REJECT" ? "REJECTED" : "PENDING_RISK");
    await call("/api/review/approval", { ...binding, decision: "APPROVE", approver: "synthetic-user", reason: "测试不能跨过缺资料或拒绝状态" }, 409, "approval");
    assert.equal((await call("/api/review/simulate", binding, 409)).error.code, "EXECUTION_BLOCKED");
    // Object reconstruction over the same Map is not a physical process restart.
    service = new ReviewService({ storage }, env);
    const replay = await call("/api/review/task/" + created.task_id, undefined, 200);
    assert.equal(replay.status, decided.workflow.status);
    assert.equal(replay.audit.audit_id, handoff.audit_id);
    assert.equal(replay.execution.execution_allowed, false);
    assert.equal(replay.execution.simulation_allowed, false);
    assert.equal(replay.execution.receipt, null);
    assert.equal(replay.audit.events.some(event => event.event_type === "execution.simulated"), false);
    const exported = evidence.buildReviewEvidence(replay, { includeContent: true });
    assert.equal(exported.manifest.consistency_status, "CONSISTENT_WITH_LIMITS");
    cases.push({ name: decision.toLowerCase(), task_id: replay.task_id, audit_id: replay.audit.audit_id, status: replay.status,
      execution_allowed: false, simulation_allowed: false, receipt: null, export_status: exported.manifest.consistency_status,
      record: replay, text: exported.text, manifest: exported.manifest });
  }
  const verification = {
    experiment_version: "account-summary-verification.v1", recorded_at: new Date().toISOString(), status: "PASS",
    input_mode: synthetic ? "SYNTHETIC" : "PRIVATE_MANUAL_TRANSCRIPTION", transport_mode: "IN_PROCESS_WORKER_HANDLER",
    model: "FIXED_TEST_DOUBLE", risk_decisions: "SIGNED_TEST_FIXTURES", external_model_calls: 0, paid_model_calls: 0,
    synthetic_provider_calls: captured.length, formal_risk_connected: false, real_user_identity_tested: false, joint_acceptance: false,
    storage: "MAP_WITH_OBJECT_RECONSTRUCTION_NOT_PROCESS_RESTART", reconciliation: report,
    cases: cases.map(({ record, text, manifest, ...entry }) => entry), transport
  };
  if (outputDirectory) {
    fs.mkdirSync(outputDirectory);
    const write = (name, content) => fs.writeFileSync(path.join(outputDirectory, name), content, { flag: "wx" });
    write("verification.json", JSON.stringify(verification, null, 2) + "\n");
    write("核对结果.txt", "\ufeff" + adapter.renderSummary(report));
    write("测试说明.txt", "\ufeff" + ["账户汇总接入测试：通过", "输入：" + verification.input_mode,
      "2 条路径：要求补资料、拒绝。每条均验证同任务交接、重复请求不再调用模型、等待/拒绝时阻断审批与模拟。",
      "请求与响应检查数：" + transport.length, "模型：固定本地测试替身；调用次数：" + captured.length,
      "正式 Risk 地址仍未配置；派发返回 503；本地签名回写只能证明代码处理路径。",
      "外部模型/付费请求：0。未发生真实交易，也未完成线上联合验收。",
      "verification.json 保存原始请求响应；两份 audit.txt 保存可读审计。内存对象重建不等于服务器进程恢复。", ""].join("\n"));
    for (const item of cases) {
      write(item.name + "-record.json", JSON.stringify(item.record, null, 2) + "\n");
      write(item.name + "-audit.txt", "\ufeff" + item.text);
      write(item.name + "-manifest.json", JSON.stringify(item.manifest, null, 2) + "\n");
    }
  }
  return verification;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const outputIndex = args.indexOf("--output-dir"), inputIndex = args.indexOf("--private-input");
  if (outputIndex < 0 || !args[outputIndex + 1]) throw new Error("--output-dir <new directory> required; optional --private-input <private JSON>");
  let input;
  if (inputIndex >= 0) {
    if (!args[inputIndex + 1] || fs.statSync(args[inputIndex + 1]).size > 10000) throw new Error("Invalid private input");
    input = JSON.parse(fs.readFileSync(args[inputIndex + 1], "utf8").replace(/^\uFEFF/, ""));
  }
  const result = await verifyAccountSummary({ input, synthetic: inputIndex < 0, outputDirectory: path.resolve(args[outputIndex + 1]) });
  console.log(JSON.stringify({ status: result.status, cases: result.cases.length, http_checks: result.transport.length,
    synthetic_provider_calls: result.synthetic_provider_calls, external_model_calls: 0, joint_acceptance: false }));
}
