"use strict";

const SERVICES = Object.freeze([
  Object.freeze({ id: "risk_validation", endpoint: "https://finance-lab-risk-bridge.realchenchenluo.workers.dev/health" }),
  Object.freeze({ id: "core_validation", endpoint: "https://finance-lab-core-risk-validation.realchenchenluo.workers.dev/health" }),
  Object.freeze({ id: "independent_chat", endpoint: "https://xinlan-qwen38-share.lixjanus526.workers.dev/api/tinglan/status" })
]);
const MAX_RESPONSE_BYTES = 64 * 1024;
const PROBE_FAILURE_CODES = new Set(["INVALID_JSON_RESPONSE", "INVALID_HTTP_RESPONSE", "RESPONSE_TOO_LARGE", "TIMEOUT", "REDIRECT_REJECTED"]);
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const nonempty = value => typeof value === "string" && value.length > 0 && value.length <= 500;

function issue(serviceId, code, message) { return { service_id: serviceId, code, message_zh: message }; }
function failed(code) { return Object.assign(new Error(code), { probeCode: code }); }

async function readBoundedJson(response, aborted) {
  if (!/^application\/json(?:\s*;|$)/i.test(response.headers?.get("content-type") || "") || typeof response.body?.getReader !== "function") throw failed("INVALID_JSON_RESPONSE");
  const reader = response.body.getReader();
  try {
    const chunks = []; let size = 0;
    while (true) {
      const part = await Promise.race([reader.read(), aborted]);
      if (part.done) break;
      if (!(part.value instanceof Uint8Array)) throw failed("INVALID_JSON_RESPONSE");
      size += part.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw failed("RESPONSE_TOO_LARGE");
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
    catch { throw failed("INVALID_JSON_RESPONSE"); }
  } finally { void reader.cancel().catch(() => {}); }
}

function classify(service, httpStatus, body) {
  const base = { id: service.id, endpoint: service.endpoint, http_status: httpStatus, status: "UNVERIFIED", health_verified: false, execution_allowed: false };
  if (service.id === "independent_chat") {
    if (httpStatus === 401 && object(body) && object(body.error) && body.error.code === "AUTHENTICATION_REQUIRED" && body.execution_allowed === false) return {
      service: { ...base, status: "AUTHENTICATION_REQUIRED", access_boundary_verified: true },
      blockers: [issue(service.id, "CHAT_SESSION_REQUIRED", "公开探测没有会话，尚不能核验对话服务内部状态；没有建立会话或调用模型。")]
    };
    return { service: base, blockers: [issue(service.id, httpStatus === 200 ? "CHAT_STATUS_NOT_VERIFIED" : "CHAT_ACCESS_NOT_VERIFIED", "未取得预期的无会话访问边界；不得据此推断模型、Risk或审批已接通。") ] };
  }
  if (httpStatus !== 200) return { service: base, blockers: [issue(service.id, "HTTP_NOT_OK", "健康检查没有取得HTTP 200，相关服务状态尚未核实。") ] };
  if (service.id === "risk_validation") {
    if (!object(body) || body.status !== "ok" || body.service !== "risk-conversation" || body.deployment !== "CLOUD_VALIDATION" || typeof body.owner_source !== "string" || !/^PR\d+-[a-f0-9]{7,40}$/.test(body.owner_source) || typeof body.model_calls_enabled !== "boolean" || typeof body.joint_acceptance !== "boolean" || body.execution_allowed !== false) return {
      service: base, blockers: [issue(service.id, "HEALTH_SCHEMA_INVALID", "Risk健康响应不完整或执行边界不符，不能认定健康检查通过。")]
    };
    const blockers = [issue(service.id, "RISK_BUSINESS_CHAIN_NOT_PROBED", "仅核验公开健康状态；未核验受保护状态、资金评估、正式回调、审批或执行。")];
    if (!body.model_calls_enabled) blockers.push(issue(service.id, "RISK_MODEL_CALLS_DISABLED", "Risk公开状态报告模型调用关闭；本次没有改变开关。"));
    if (body.joint_acceptance) blockers.push(issue(service.id, "JOINT_ACCEPTANCE_CLAIM_NOT_VERIFIED", "服务自述的联合验收状态不能替代本次同任务证据核查。"));
    return { service: { ...base, status: "HEALTH_ONLY", health_verified: true, deployment: body.deployment, owner_source: body.owner_source, model_calls_enabled: body.model_calls_enabled }, blockers };
  }
  if (!object(body) || body.status !== "ok" || body.service !== "core-agent" || body.contract_version !== "investment-agent.v1" || body.review_endpoint !== "/api/review" || body.docs !== "/docs" || !object(body.model) || !nonempty(body.model.provider) || !nonempty(body.model.name) || typeof body.model.configured !== "boolean" || !["durable_object", "unconfigured"].includes(body.audit_storage)) return {
    service: base, blockers: [issue(service.id, "HEALTH_SCHEMA_INVALID", "Core健康响应不完整，不能认定健康检查通过。")]
  };
  const blockers = [issue(service.id, "CORE_CALLBACK_AUTH_NOT_PROBED", "公开健康检查不证明机器身份、Risk签名、固定审核身份或正式业务回调已联合验收。")];
  if (!body.model.configured) blockers.push(issue(service.id, "CORE_MODEL_NOT_CONFIGURED", "Core公开状态报告模型未配置；本次没有运行推理探测。"));
  if (body.audit_storage !== "durable_object") blockers.push(issue(service.id, "CORE_AUDIT_STORAGE_NOT_CONFIGURED", "Core公开状态未声明已配置Durable Object审计存储。"));
  return { service: { ...base, status: "HEALTH_ONLY", health_verified: true, contract_version: body.contract_version, model_configured: body.model.configured, audit_storage: body.audit_storage }, blockers };
}

async function probe(service, fetchImpl, timeoutMs) {
  const controller = new AbortController(); let rejectAbort;
  const aborted = new Promise((_, reject) => { rejectAbort = reject; });
  const timer = setTimeout(() => { rejectAbort(failed("TIMEOUT")); controller.abort(); }, timeoutMs);
  let httpStatus = null;
  try {
    // This fixed allowlist never accepts a caller URL, cookie, key, or POST body.
    const response = await Promise.race([Promise.resolve().then(() => fetchImpl(service.endpoint, {
      method: "GET", redirect: "manual", credentials: "omit", headers: { Accept: "application/json" }, signal: controller.signal
    })), aborted]);
    if (!response || !Number.isInteger(response.status)) throw failed("INVALID_HTTP_RESPONSE");
    httpStatus = response.status;
    if (response.redirected || httpStatus >= 300 && httpStatus < 400) throw failed("REDIRECT_REJECTED");
    return classify(service, httpStatus, await readBoundedJson(response, aborted));
  } catch (error) {
    // Do not report remote response text, exception messages, headers or secrets.
    const code = PROBE_FAILURE_CODES.has(error?.probeCode) ? error.probeCode : controller.signal.aborted ? "TIMEOUT" : "NETWORK_ERROR";
    return { service: { id: service.id, endpoint: service.endpoint, http_status: httpStatus, status: "UNAVAILABLE", health_verified: false, execution_allowed: false },
      blockers: [issue(service.id, code, "只读探测失败或响应无法验证；未建立会话、调用模型、发送回调或执行操作。") ] };
  } finally { clearTimeout(timer); controller.abort(); }
}

async function runPreflight(options = {}) {
  if (!object(options) || Object.keys(options).some(key => !["fetchImpl", "timeoutMs"].includes(key))) throw new TypeError("Only fetchImpl and timeoutMs are supported.");
  const { fetchImpl = globalThis.fetch, timeoutMs = 8000 } = options;
  if (typeof fetchImpl !== "function" || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new TypeError("A fetch function and an integer timeout of 1 to 60000 milliseconds are required.");
  const checkedAt = new Date().toISOString();
  const results = await Promise.all(SERVICES.map(service => probe(service, fetchImpl, timeoutMs)));
  return { schema_version: "risk-joint-preflight.v1", checked_at: checkedAt, mode: "READ_ONLY_PREFLIGHT", real_model_calls: 0,
    joint_acceptance: false, execution_allowed: false, services: results.map(row => row.service),
    blockers: [issue(null, "JOINT_ACCEPTANCE_NOT_PERFORMED", "三条公开GET探测不构成模型→Risk→审批→执行联合验收；后续须核验同一任务的完整证据。"), ...results.flatMap(row => row.blockers)] };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    process.stdout.write("Usage: node preflight.cjs [--out <new-report.json>]\nOnly three fixed public GET probes are performed. No credentials or model calls.\n"); return;
  }
  if (args.length && (args.length !== 2 || args[0] !== "--out" || !args[1])) throw new Error("Use --out <new-report.json> or --help.");
  const result = await runPreflight();
  const serialized = JSON.stringify(result, null, 2) + "\n";
  if (args.length) require("node:fs").writeFileSync(require("node:path").resolve(args[1]), serialized, { flag: "wx" });
  process.stdout.write(serialized);
  // A preflight report never makes a successful joint-acceptance claim.
  process.exitCode = result.blockers.length ? 2 : 0;
}

if (require.main === module) main().catch(() => { process.stderr.write("Read-only preflight could not produce its report. Use --help for supported arguments.\n"); process.exitCode = 1; });
module.exports = { runPreflight };
