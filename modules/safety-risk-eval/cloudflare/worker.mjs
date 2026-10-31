import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import reviewerModule from "../interface-adapters/conversation-review.cjs";
import inputModule from "../interface-adapters/conversation-input.cjs";
import riskModule from "../interface-adapters/conversation-risk.cjs";
import buildInfo from "generated-risk-build-info";
import { RiskCloudStore, hash } from "./store.mjs";

const { createConversationReviewer } = reviewerModule;
const { normalizeConversationFinance } = inputModule;
const { assessConversation } = riskModule;
const ACTOR = "finance-lab-cloud-validation";
const MAX_BYTES = 128 * 1024;
const fail = (code, message, status = 422) => { throw Object.assign(new Error(message), { code, status }); };
const json = (status, value) => Response.json(value, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
const safeText = value => typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value);
function authenticate(request, env) {
  const expected = env.RISK_CONVERSATION_API_KEY;
  if (typeof expected !== "string" || !/^[\x21-\x7e]{24,200}$/.test(expected)) fail("SERVICE_AUTH_NOT_CONFIGURED", "服务端身份尚未配置，接口暂停。", 503);
  if (request.headers.has("Origin")) fail("BROWSER_ACCESS_DENIED", "机器接口仅供授权服务端调用。", 403);
  const supplied = request.headers.get("X-Risk-Conversation-Key") || "";
  if (supplied.length > 200 || !timingSafeEqual(createHash("sha256").update(supplied).digest(), createHash("sha256").update(expected).digest())) fail("SERVICE_AUTH_REQUIRED", "缺少有效服务端身份。", 401);
}
function configuration(env) {
  let coreUrl;
  try { coreUrl = new URL(env.CORE_AGENT_BASE_URL); } catch { fail("CORE_URL_INVALID", "Core地址尚未配置。", 503); }
  if (coreUrl.protocol !== "https:" || coreUrl.pathname !== "/" || coreUrl.username || coreUrl.password || coreUrl.search || coreUrl.hash || coreUrl.hostname.endsWith(".invalid")) fail("CORE_URL_INVALID", "须使用团队确认的Core HTTPS源站。", 503);
  if (![env.CORE_AGENT_API_KEY, env.RISK_SERVICE_HMAC_SECRET].every(value => typeof value === "string" && value.length >= 24 && value.length <= 10000 && value.trim() === value)) fail("TRUSTED_CORE_CONFIGURATION_REQUIRED", "Core访问及Risk签名配置不完整。", 503);
  if (!safeText(env.RISK_REVIEWER_ID) || env.REQUIRE_TRUSTED_ACTORS !== "true" || env.REQUIRE_RISK_REVIEWER !== "true") fail("STRICT_IDENTITY_CONFIGURATION_REQUIRED", "本云适配要求固定审核者和严格身份开关，不能降级演示身份。", 503);
  return { baseUrl: coreUrl.origin, apiKey: env.CORE_AGENT_API_KEY, hmacSecret: env.RISK_SERVICE_HMAC_SECRET,
    reviewer: env.RISK_REVIEWER_ID, timeoutMs: 60000, dailyLimit: 5 };
}
async function readPayload(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("Content-Type") || "")) fail("INVALID_CONTENT_TYPE", "请求须使用application/json。", 415);
  const reader = request.body?.getReader(), parts = [];
  let size = 0;
  if (reader) while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_BYTES) { await reader.cancel(); fail("BODY_TOO_LARGE", "资料超出大小限制。", 413); }
    parts.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  let value;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { fail("INVALID_JSON", "请求须为有效JSON。", 400); }
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !["question", "daily_finance_yuan", "idempotency_key"].includes(key))) fail("UNTRUSTED_CONTROL_FIELD", "只接受问题、资金事实和请求编号；不接受权限或执行指令。");
  if (typeof value.question !== "string" || !value.question.trim() || value.question.length > 20000) fail("INVALID_QUESTION", "请输入1至20000字的问题。");
  if (typeof value.idempotency_key !== "string" || !/^[A-Za-z0-9_.:-]{8,100}$/.test(value.idempotency_key)) fail("IDEMPOTENCY_KEY_REQUIRED", "需要稳定的8至100位请求编号。");
  return value;
}
function errorResponse(error) {
  return json(error.status || error.statusCode || 503, { ...error.partial,
    error: { code: error.code || "RISK_SERVICE_UNAVAILABLE", message: error.code ? error.message : "风控服务异常，执行保持关闭。" },
    execution_allowed: false, executed: false, queued: false });
}
export class RiskConversationService {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.store = new RiskCloudStore(ctx.storage);
    this.pending = 0;
    this.queue = Promise.resolve();
    this.storageFailed = false;
  }
  async flush() {
    if (this.storageFailed) fail("STORAGE_RECONCILIATION_REQUIRED", "存储状态未决，后续请求暂停。", 503);
    try { await this.ctx.storage.sync(); }
    catch { this.storageFailed = true; fail("STORAGE_DURABILITY_UNCONFIRMED", "审计或状态持久化未确认，请核查原请求后恢复。", 503); }
  }
  async fetch(request) {
    try { authenticate(request, this.env); } catch (error) { return errorResponse(error); }
    if (this.storageFailed) return errorResponse({ code: "STORAGE_RECONCILIATION_REQUIRED", message: "存储状态未决，后续请求暂停。", status: 503 });
    if (this.pending >= 4) return errorResponse({ code: "VALIDATION_QUEUE_FULL", message: "联调队列已满，请稍后核查。", status: 429 });
    this.pending++;
    const response = this.queue.then(() => this.handle(request));
    this.queue = response.catch(() => {});
    try { return await response; } finally { this.pending--; }
  }
  async handle(request) {
    try {
      // Requests queued before a prior failure must recheck at dequeue time.
      if (this.storageFailed) fail("STORAGE_RECONCILIATION_REQUIRED", "存储状态未决，后续请求暂停。", 503);
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/api/status") {
        let configError = null;
        try { configuration(this.env); } catch (error) { configError = error.code; }
        return json(200, { service: "risk-conversation", ...buildInfo, configured: configError === null, configuration_error: configError,
          core_connection_verified: false, fixed_reviewer_configured: safeText(this.env.RISK_REVIEWER_ID), end_user_identity_verified: false,
          user_isolation_verified: false, scope: "SINGLE_SERVICE_SYNTHETIC",
          model_calls_enabled: this.env.RISK_MODEL_CALLS_ENABLED === "true", model_probe: "NOT_RUN", supported_capability: "REVIEW_ONLY",
          formal_joint_acceptance: false, execution_allowed: false });
      }
      if (request.method === "GET" && url.pathname.startsWith("/api/records/")) {
        const segments = url.pathname.slice("/api/records/".length).split("/");
        const route = segments.length === 1 ? "assess" : segments[0];
        const token = decodeURIComponent(segments.length === 1 ? segments[0] : segments[1]);
        if (!["assess", "review"].includes(route) || segments.length > 2 || !/^[A-Za-z0-9_.:-]{8,100}$/.test(token)) fail("INVALID_RECORD_ID", "记录编号无效。");
        const key = hash(route === "review" ? { actor: ACTOR, requestToken: token } : { actor: ACTOR, route: "/api/assess", requestToken: token });
        const record = this.store.data.requests[key];
        if (!record) fail("NOT_FOUND", "没有该检查记录。", 404);
        return json(200, { record, audit_events: this.store.events.filter(row => row.request_key === key), execution_allowed: false });
      }
      if (request.method !== "POST" || !["/api/assess", "/api/review"].includes(url.pathname)) fail("NOT_FOUND", "接口不存在。", 404);
      if (url.pathname === "/api/review") {
        if (this.env.RISK_MODEL_CALLS_ENABLED !== "true") fail("MODEL_CALLS_DISABLED", "模型调用关闭；本次没有生成模型响应或正式回调。", 423);
        const config = configuration(this.env);
        const reviewer = createConversationReviewer({ store: this.store, config,
          fetchImpl: async (target, options) => { await this.flush(); return fetch(target, options); } });
        const result = await reviewer.review(await readPayload(request), ACTOR);
        await this.flush();
        return json(200, result);
      }
      const payload = await readPayload(request);
      const key = hash({ actor: ACTOR, route: "/api/assess", requestToken: payload.idempotency_key });
      const begun = this.store.begin(key, hash(payload));
      if (begun.replay) return json(200, { ...begun.response, replayed: true });
      try {
        const now = new Date().toISOString();
        const finance = normalizeConversationFinance(payload.daily_finance_yuan, now);
        const assessment = assessConversation({ question: payload.question, dailyFinance: finance, now, checkId: `cloud-risk-${randomUUID()}` });
        const event = this.store.audit(key, "PROGRAM_ASSESSMENT_ONLY", { assessment, model_called: false, callback_sent: false, execution_allowed: false });
        const value = { ...assessment, model_status: "NOT_CALLED", decision_source: "PROGRAM_ONLY", formal_risk_callback: "NOT_SENT",
          audit_event_id: event.event_id, data_mode: "SYNTHETIC_REPLAY", execution_allowed: false, executed: false, replayed: false };
        this.store.update(key, { status: "COMPLETE", response: value });
        await this.flush();
        return json(200, value);
      } catch (error) {
        this.store.audit(key, "PROGRAM_ASSESSMENT_FAILED", { code: error.code || "ASSESSMENT_FAILED", execution_allowed: false });
        this.store.update(key, { status: "UNKNOWN", error_code: error.code || "ASSESSMENT_FAILED" });
        throw error;
      }
    } catch (error) { return errorResponse(error); }
  }
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") return json(200, { status: "ok", service: "risk-conversation", ...buildInfo,
      worker_version_id: env.CF_VERSION_METADATA?.id ?? null, deployment_id: null,
      user_isolation_verified: false, scope: "SINGLE_SERVICE_SYNTHETIC",
      mode: "CANDIDATE_READ_ONLY_SYNTHETIC", model_calls_enabled: env.RISK_MODEL_CALLS_ENABLED === "true",
      core_owner_bridge_receiver: false, simulation_callback_http: false, formal_joint_acceptance: false, execution_allowed: false });
    if (request.method === "GET" && ["/", "/docs"].includes(url.pathname)) return json(200, {
      service: "risk-conversation", ...buildInfo, endpoints: ["GET /health", "GET /api/status", "POST /api/assess", "POST /api/review", "GET /api/records/{assess|review}/{id}"],
      direction: "Risk conversation -> Core review -> REVIEW_ONLY signed callback", core_owner_bridge_receiver: false,
      user_isolation_verified: false, scope: "SINGLE_SERVICE_SYNTHETIC",
      simulation_callback_http: false, notice_zh: "候选服务仅供授权服务端联调；模型和资金写入默认关闭。不是新增用户展示站点，不证明正式联合验收。" });
    try {
      authenticate(request, env);
      if (request.method === "POST" && ["/api/risk-handoff", "/api/handoff"].includes(url.pathname)) fail("OWNER_BRIDGE_RECEIVER_NOT_IMPLEMENTED", "本候选不接收Core主动派发包，不能把它配置成RISK_SERVICE_URL。", 501);
      if (!env.RISK_CONVERSATIONS?.get || !env.RISK_CONVERSATIONS?.idFromName) fail("DURABLE_STORAGE_NOT_CONFIGURED", "未绑定Durable Object，相关检查暂停。", 503);
      return await env.RISK_CONVERSATIONS.get(env.RISK_CONVERSATIONS.idFromName("risk-validation-v1")).fetch(request);
    } catch (error) { return errorResponse(error); }
  }
};
