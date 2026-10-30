"use strict";

const { randomUUID, createHash } = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const { buildRiskCallbackDraft, extractCoreBinding } = require("./risk-callback.cjs");
const { signatureFor, canonicalJson } = require("../../../chenchen/integrations/owner-bridge.js");
const { validateRiskCallback } = require("../../../chenchen/integrations/risk-handoff.js");

const SENDER_VERSION = "risk-core-callback-sender.v1";
const MAX_RESPONSE_BYTES = 512 * 1024;
const ENDPOINT = "/api/review/risk-callback";
const BINDING_FIELDS = ["handoff_id", "task_id", "request_id", "run_id", "audit_id", "proposal_sha256"];
const RETRY_ACTION = "RECONCILE_CORE_TASK_AND_PERSISTED_OUTCOME_BEFORE_ANY_RETRY";

class CallbackSenderError extends Error {
  constructor(code, message, statusCode = 409) {
    super(message);
    this.name = "CallbackSenderError";
    this.code = code;
    this.statusCode = statusCode;
    this.execution_allowed = false;
    this.dispatch_allowed = false;
    this.retryable = false;
  }
}

function fail(code, message, statusCode) { throw new CallbackSenderError(code, message, statusCode); }
function object(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function equal(a, b) { return isDeepStrictEqual(a, b); }
function clone(value) { return structuredClone(value); }
function text(value, max = 500) { return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= max; }

function serverConfig(config) {
  if (!object(config) || !text(config.baseUrl, 2000) || !text(config.apiKey, 10000) || !text(config.hmacSecret, 10000) || !text(config.reviewer)) {
    fail("CALLBACK_CONFIG_REQUIRED", "服务端回调地址、身份和签名配置不完整。", 503);
  }
  let url;
  try { url = new URL(config.baseUrl); } catch { fail("CALLBACK_ORIGIN_INVALID", "服务端必须配置有效的 Core 源站地址。", 503); }
  if (url.username || url.password || /[?#]/.test(config.baseUrl) || url.pathname !== "/") {
    fail("CALLBACK_ORIGIN_INVALID", "Core 配置只允许源站，不允许凭据、路径、查询或片段。", 503);
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local && config.allowLocalHttp === true)) {
    fail("CALLBACK_HTTPS_REQUIRED", "Core 回调必须使用 HTTPS；HTTP 仅用于显式开启的本地测试。", 503);
  }
  const timeoutMs = config.timeoutMs === undefined ? 12000 : config.timeoutMs;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) fail("CALLBACK_TIMEOUT_INVALID", "回调超时须为 1 至 60000 毫秒整数。", 503);
  return { url: url.origin + ENDPOINT, apiKey: config.apiKey, hmacSecret: config.hmacSecret, reviewer: config.reviewer, timeoutMs };
}

function verifyCurrent(draft, current, reviewer, expectedCapability) {
  if (!object(current) || current.versions_current !== true) fail("RISK_CHECK_STALE", "画像、方案、数据或规则版本已变化；请重新检查。");
  const binding = extractCoreBinding(current.handoff);
  if (current.handoff.capability !== expectedCapability) fail("CALLBACK_CAPABILITY_INVALID", `本轮回写仅接受 ${expectedCapability} 的 Core 任务。`);
  if (!object(draft?.audit_context) || draft.status !== "DRAFT_READY" || draft.callback === null || draft.risk_decision === "ERROR") {
    fail("CALLBACK_NOT_SENDABLE", "异常或未完成检查只能保留错误记录，不能发送业务回调。");
  }
  const audit = draft.audit_context;
  for (const field of ["risk_check_id", "policy_version", "checked_at"]) {
    if (current[field] !== audit[field]) fail("RISK_CHECK_STALE", "回调草稿不再对应当前检查、规则或检查时间。");
  }
  if (!equal(binding, audit.core_binding)) fail("RISK_BINDING_MISMATCH", "回调草稿与当前 Core 六项绑定不一致。");
  if (draft.callback?.reviewer !== reviewer) fail("RISK_REVIEWER_MISMATCH", "回调签署者必须来自服务端配置。");
  const expected = buildRiskCallbackDraft({ handoff: current.handoff, reviewer, risk_result: {
    risk_check_id: audit.risk_check_id, decision: draft.risk_decision, check_complete: draft.risk_decision !== "ERROR",
    checked_at: audit.checked_at, policy_version: audit.policy_version, core_binding: audit.core_binding,
    local_task_id: audit.local_task_id, reasons: audit.reasons
  } });
  if (!equal(draft, expected)) fail("CALLBACK_DRAFT_CHANGED", "草稿与确定性风险结果不一致，必须重新生成。");
  return binding;
}

function verifyReceipt(body, callback, expectedCapability) {
  if (!object(body) || body.error || !["RECORDED", "DUPLICATE"].includes(body.callback_status) || !object(body.workflow)) {
    fail("CALLBACK_RECEIPT_INVALID", "Core 未返回可验证的风险回执。", 502);
  }
  const workflow = body.workflow;
  // Validate against the actual workflow, not the response's caller-controlled trace.
  try { validateRiskCallback(callback, workflow); }
  catch { fail("CALLBACK_RECEIPT_BINDING_MISMATCH", "Core 回执与发送任务或方案摘要不一致。", 502); }
  if (workflow.capability !== expectedCapability) {
    fail("CALLBACK_RECEIPT_CAPABILITY_INVALID", `Core 回执能力必须保持为 ${expectedCapability}。`, 502);
  }
  const unhashed = { ...workflow.proposed_action }; delete unhashed.proposal_sha256;
  if (createHash("sha256").update(JSON.stringify(unhashed), "utf8").digest("hex") !== callback.proposal_sha256) {
    fail("CALLBACK_RECEIPT_BINDING_MISMATCH", "Core 回执中的完整方案与原摘要不一致。", 502);
  }
  if (workflow.workflow_version !== "review-workflow.v1" || workflow.execution_mode !== "PAPER" || workflow.risk_handoff?.execution_allowed !== false || workflow.execution?.execution_allowed !== false) {
    fail("CALLBACK_RECEIPT_CONTROL_INVALID", "Core 回执执行边界不符合 PAPER 风控协议。", 502);
  }
  const risk = workflow.risk_decision;
  const receipt = workflow.risk_callback;
  if (!object(risk) || !text(risk.risk_decision_id) || !text(risk.decided_at) || risk.task_id !== callback.task_id || risk.proposal_sha256 !== callback.proposal_sha256 || risk.decision !== callback.decision || risk.reason !== callback.reason || risk.reviewer !== callback.reviewer || !object(receipt) || receipt.callback_version !== callback.callback_version || !equal(receipt.request, callback)) {
    fail("CALLBACK_RECEIPT_DECISION_MISMATCH", "Core 风险决定或原始回调与发送内容不一致。", 502);
  }
  const expectedStatus = { APPROVE: "APPROVED", REJECT: "REJECTED", REQUEST_MORE_INFO: "PENDING_REVIEW" }[callback.decision];
  if (risk.status !== expectedStatus || workflow.risk_handoff.decision !== callback.decision) fail("CALLBACK_RECEIPT_DECISION_MISMATCH", "Core 风险状态与回调决定不一致。", 502);
  for (const auth of [risk.auth, receipt.auth]) {
    if (!object(auth) || auth.verified !== true || auth.mode !== "HMAC_SHA256" || auth.owner !== "risk" || auth.actor !== callback.reviewer || auth.signature_header !== "X-Risk-Signature") {
      fail("CALLBACK_RECEIPT_UNVERIFIED", "Core 未提供匹配的可信 Risk 签名验证记录。", 502);
    }
  }
  if (body.handoff !== undefined) {
    const handoff = body.handoff;
    if (!object(handoff) || BINDING_FIELDS.some(field => (field === "proposal_sha256" ? handoff.proposal?.proposal_sha256 : handoff[field]) !== callback[field]) || handoff.execution_allowed !== false) {
      fail("CALLBACK_RECEIPT_BINDING_MISMATCH", "Core 返回的 Handoff 与已确认回调不一致。", 502);
    }
  }
  return { callback_status: body.callback_status, workflow_status: workflow.status, risk_decision_id: risk.risk_decision_id,
    decision: risk.decision, reviewer: risk.reviewer, reason: risk.reason, decided_at: risk.decided_at,
    auth: clone(risk.auth), human_approval_status: workflow.approval?.status || null,
    execution_status: workflow.execution.status, execution_allowed: false };
}

async function readReceipt(response, aborted) {
  if (!response || response.redirected || response.status >= 300 && response.status < 400 || !response.ok) fail("CALLBACK_HTTP_REJECTED", "Core HTTP 回调未取得成功响应；请核查任务状态。", 502);
  if (!/^application\/json(?:\s*;|$)/i.test(response.headers?.get("Content-Type") || "") || typeof response.body?.getReader !== "function") fail("CALLBACK_RECEIPT_INVALID", "Core 回执必须是有界 JSON。", 502);
  const reader = response.body.getReader();
  try {
    const chunks = []; let size = 0;
    while (true) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) fail("CALLBACK_RESPONSE_TOO_LARGE", "Core 回执超过大小限制，需核查任务状态。", 502);
      chunks.push(value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
    catch { fail("CALLBACK_RECEIPT_INVALID", "Core 回执不是有效 JSON，需核查任务状态。", 502); }
  } finally { void reader.cancel().catch(() => {}); }
}

async function persist(writer, value) {
  const result = await writer(clone(value));
  if (result === false || object(result) && result.persisted === false) throw new Error("Persistence refused");
}

// Callers must serialize a task and durably deduplicate attempts. After a callback
// is accepted, replay the stored outcome; do not reload it as a pending handoff or
// blindly resend after a timeout. REQUEST_MORE_INFO needs a new Core reviewed task.
// Persistence callbacks resolve only after durable storage and throw on failure.
async function sendRiskCallbackInternal({ draft, loadCurrent, persistIntent, persistOutcome, config, fetchImpl = globalThis.fetch } = {}, expectedCapability, senderVersion) {
  const settings = serverConfig(config);
  if ([loadCurrent, persistIntent, persistOutcome, fetchImpl].some(fn => typeof fn !== "function")) fail("CALLBACK_DEPENDENCY_REQUIRED", "缺少可信状态读取、审计持久化或 HTTP 适配。", 503);
  let snapshot;
  try { snapshot = clone(draft); } catch { fail("CALLBACK_DRAFT_INVALID", "回调草稿无法读取。"); }
  let current;
  try { current = await loadCurrent(); } catch { fail("CALLBACK_STATE_UNAVAILABLE", "无法读取当前可信任务，回调暂停。", 503); }
  const binding = verifyCurrent(snapshot, current, settings.reviewer, expectedCapability);
  const body = canonicalJson(snapshot.callback);
  const attemptId = "risk-send-" + randomUUID();
  const startedAt = new Date().toISOString();
  const base = { sender_version: senderVersion, attempt_id: attemptId, core_binding: clone(binding), capability: expectedCapability,
    risk_check_id: snapshot.audit_context.risk_check_id, policy_version: snapshot.audit_context.policy_version,
    checked_at: snapshot.audit_context.checked_at, callback_sha256: createHash("sha256").update(body).digest("hex"),
    execution_allowed: false };
  const intent = { ...base, status: "INTENT_RECORDED", started_at: startedAt, endpoint: settings.url,
    callback: clone(snapshot.callback), audit_context: clone(snapshot.audit_context) };
  try { await persist(persistIntent, intent); } catch { fail("CALLBACK_INTENT_NOT_DURABLE", "发送意图未持久化，尚未调用 Core。", 503); }
  const signature = await signatureFor(body, settings.hmacSecret);
  try { current = await loadCurrent(); } catch { fail("CALLBACK_STATE_UNAVAILABLE", "发送前无法重新读取可信任务，回调暂停。", 503); }
  // A state change during audit persistence must not race into a stale approval.
  verifyCurrent(snapshot, current, settings.reviewer, expectedCapability);
  const controller = new AbortController();
  let abortListener;
  const aborted = new Promise((_, reject) => {
    abortListener = () => reject(new CallbackSenderError("CALLBACK_TIMEOUT", "回调响应超时，结果未知，必须核查。", 504));
    controller.signal.addEventListener("abort", abortListener, { once: true });
  });
  const timer = setTimeout(() => controller.abort(), settings.timeoutMs);
  let result;
  try {
    const response = await Promise.race([Promise.resolve().then(() => fetchImpl(settings.url, {
      method: "POST", redirect: "manual", signal: controller.signal,
      headers: { "Content-Type": "application/json", "X-Core-Agent-Key": settings.apiKey, "X-Risk-Signature": signature },
      body
    })), aborted]);
    const receipt = verifyReceipt(await readReceipt(response, aborted), snapshot.callback, expectedCapability);
    result = { ...base, status: receipt.callback_status, dispatch_performed: true, requires_reconciliation: false,
      outcome_persisted: true, completed_at: new Date().toISOString(), receipt,
      required_next_actions: ["REPLAY_DURABLE_OUTCOME_FOR_REPEATED_REQUESTS", "KEEP_HUMAN_APPROVAL_AND_ACTION_GATEWAY_SEPARATE"] };
    if (snapshot.risk_decision === "REVIEW") result.required_next_actions.push("AFTER_ACCEPTED_REQUEST_MORE_INFO_CREATE_NEW_CORE_TASK_AND_HANDOFF");
  } catch (error) {
    const safe = error instanceof CallbackSenderError ? error : new CallbackSenderError("CALLBACK_NETWORK_UNKNOWN", "回调连接异常，是否已记录未知；必须核查。", 502);
    result = { ...base, status: "UNKNOWN", dispatch_performed: true, requires_reconciliation: true,
      outcome_persisted: true, completed_at: new Date().toISOString(), receipt: null,
      error: { code: safe.code, message_zh: safe.message }, required_next_actions: [RETRY_ACTION] };
  } finally {
    clearTimeout(timer);
    controller.signal.removeEventListener("abort", abortListener);
    controller.abort();
  }
  try { await persist(persistOutcome, result); }
  catch {
    // The intent remains the durable evidence of an unresolved possible send.
    return { ...base, status: "UNKNOWN", dispatch_performed: true, requires_reconciliation: true,
      outcome_persisted: false, completed_at: new Date().toISOString(), receipt: null,
      error: { code: "CALLBACK_OUTCOME_NOT_DURABLE", message_zh: "回调结果未持久化，请凭发送意图核查 Core；禁止盲目重发。" },
      required_next_actions: ["RESTORE_AUDIT_STORAGE", RETRY_ACTION] };
  }
  return result;
}

async function sendRiskCallback(args = {}) {
  return sendRiskCallbackInternal(args, "REVIEW_ONLY", SENDER_VERSION);
}

// Explicit simulation path for the PAPER demo. It is deliberately separate from
// the read-only sender so a REVIEW_ONLY task can never be upgraded by a callback.
async function sendSimulationCallback(args = {}) {
  return sendRiskCallbackInternal(args, "SIMULATION_ONLY", "risk-core-simulation-callback-sender.v1");
}

module.exports = { sendRiskCallback, sendSimulationCallback, CallbackSenderError, SENDER_VERSION, MAX_RESPONSE_BYTES };
