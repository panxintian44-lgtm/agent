import harnessModule from "../core/harness.js";
import toolsModule from "../tools/financial-tools.js";
import contractModule from "../contracts/investment-contract.js";
import adapterModule from "../integrations/risk-workbench-adapter.js";
import modelReviewModule from "../integrations/model-review.js";
import legacyReviewAdapterModule from "../integrations/legacy-review-adapter.js";
import riskHandoffModule from "../integrations/risk-handoff.js";
import ownerBridgeModule from "../integrations/owner-bridge.js";
import reviewWorkflowModule from "../integrations/review-workflow.js";
import fundingPlanModule from "../integrations/funding-plan.js";
import coreErrorModule from "../contracts/core-agent-error.js";
import bailianBudgetModule from "../integrations/bailian-budget.js";
import reviewReservationModule from "../integrations/review-reservation.js";
import reviewTransitionModule from "../integrations/review-transition.js";
import { reviewDocs } from "./review-docs.js";

const { Harness } = harnessModule;
const tools = toolsModule;
const contract = contractModule;
const { buildRiskWorkbenchHandoff } = adapterModule;
const modelReview = modelReviewModule;
const legacyReviewAdapter = legacyReviewAdapterModule;
const riskHandoff = riskHandoffModule;
const ownerBridge = ownerBridgeModule;
const { ReviewWorkflowStore, WorkflowError, matchesRequestFingerprint } = reviewWorkflowModule;
const { FundingPlanStore } = fundingPlanModule;
const coreError = coreErrorModule;
const harness = new Harness({ toolset: tools });
const DEFAULT_ORIGINS = [
  "https://fund-risk-workbench.panxintian44.chatgpt.site",
  "https://realchenchenluo.github.io"
];
const rateBuckets = new Map();

function originFor(request, env) {
  const origin = request.headers.get("Origin");
  const configured = String(env.CORS_ORIGINS || DEFAULT_ORIGINS.join(","))
    .split(",").map(value => value.trim()).filter(Boolean);
  return origin && (configured.includes("*") || configured.includes(origin)) ? origin : null;
}

function headers(request, env, contentType = "application/json; charset=utf-8") {
  const result = { "Content-Type": contentType, "Cache-Control": "no-store" };
  const origin = originFor(request, env);
  if (origin) {
    result["Access-Control-Allow-Origin"] = origin;
    result["Access-Control-Allow-Methods"] = "GET,POST,OPTIONS";
    result["Access-Control-Allow-Headers"] = "Content-Type, X-Core-Agent-Key, Idempotency-Key, X-Request-ID, X-Risk-Signature, X-Approval-Signature";
    result.Vary = "Origin";
  }
  return result;
}

function json(request, env, status, payload, extraHeaders = {}) {
  return new Response(JSON.stringify(payload), { status, headers: { ...headers(request, env), ...extraHeaders } });
}

function errorPayload(error, requestId = null) {
  return contract.buildErrorResponse(error, {
    requestId,
    taskId: error.trace?.task_id || null,
    sessionId: error.trace?.session_id || null,
    auditId: error.trace?.audit_id || null
  });
}

async function readJson(request) {
  const reader = request.body?.getReader();
  const chunks = [];
  let size = 0;
  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 100000) {
        await reader.cancel();
        throw new modelReview.ReviewError("REQUEST_TOO_LARGE", "请求正文不能超过 100KB。", { statusCode: 413, stage: "VALIDATION" });
      }
      chunks.push(value);
    }
  }
  try {
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    const error = new Error("request body must be valid JSON");
    error.code = "INVALID_JSON";
    error.statusCode = 400;
    throw error;
  }
}

function authFailure() {
  const error = new Error("API authentication is required");
  error.code = "AUTHENTICATION_REQUIRED";
  error.statusCode = 401;
  error.recovery = "Provide the configured X-Core-Agent-Key and retry.";
  return error;
}

function rateLimitFailure() {
  const error = new Error("rate limit exceeded");
  error.code = "RATE_LIMITED";
  error.statusCode = 429;
  error.retryable = true;
  error.recovery = "Wait before retrying the request.";
  return error;
}

function serviceUnavailableFailure() {
  const error = new Error("复核服务暂时不可用，请稍后重试。");
  error.code = "REVIEW_SERVICE_UNAVAILABLE";
  error.statusCode = 503;
  error.retryable = true;
  error.stage = "BACKEND";
  error.recovery = "稍后重试；如果持续失败，请检查 Durable Object 和模型服务状态。";
  return error;
}

function routeNotFoundFailure() {
  const error = new Error("route not found");
  error.code = "NOT_FOUND";
  error.statusCode = 404;
  error.stage = "ROUTING";
  error.recovery = "Use a documented Core Agent endpoint and retry.";
  return error;
}

function capabilityStatus(env) {
  const config = modelReview.resolveModelConfig(env);
  const provider = String(config.provider || "").toLowerCase();
  const workersAi = config.style === "workers_ai";
  const modelConfigured = workersAi
    ? typeof env.AI?.run === "function"
    : Boolean(config.apiKey && config.model && !config.configurationIssue);
  const riskConfig = ownerBridge.ownerConfigurationStatus("risk", env);
  const approvalConfig = ownerBridge.ownerConfigurationStatus("approval", env);
  const riskUrlConfigured = Boolean(String(env.RISK_SERVICE_URL || "").trim());
  return {
    capability_version: "core-agent-capabilities.v1",
    service: "core-agent",
    contract_version: modelReview.REVIEW_VERSION,
    model: {
      provider,
      name: config.model || null,
      configured: modelConfigured,
      inference_probe: "NOT_RUN",
      response_id_sources: ["body.id", "body.response_id", "header.x-request-id", "header.x-correlation-id"],
      paid_calls_this_check: 0
    },
    risk: {
      handoff_contract: "risk-handoff.v1",
      dispatch_url_configured: riskUrlConfigured,
      dispatch_signature_configured: riskConfig.secret_configured,
      dispatch_ready: riskUrlConfigured && riskConfig.secret_configured && !riskConfig.configuration_error,
      callback_signature_configured: riskConfig.secret_configured,
      signature_secret_name: riskConfig.secret_name,
      fixed_reviewer_configured: riskConfig.reviewer_configured,
      strict_reviewer_required: riskConfig.require_risk_reviewer,
      strict_trusted_actors: riskConfig.require_trusted_actors,
      configuration_error: riskConfig.configuration_error
    },
    approval: {
      decision_endpoint: "/api/review/approval",
      signature_configured: approvalConfig.secret_configured,
      signature_secret_name: approvalConfig.secret_name,
      // A service signature proves the calling service, not the end user's login,
      // account ownership, task authorization, or personal approval.
      trusted_identity_ready: false,
      trusted_identity_evidence: "APPROVAL_SERVICE_REQUIRED",
      demo_actor_labels_allowed: !approvalConfig.secret_configured && !approvalConfig.require_trusted_actors,
      configuration_error: approvalConfig.configuration_error
    },
    execution: {
      mode: "PAPER",
      allowed: false,
      gateway_connected: false
    },
    acceptance: {
      synthetic_local: true,
      real_model: false,
      formal_risk_callback: false,
      joint_acceptance: false
    }
  };
}

function requestIdentity(request) {
  return request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For")?.split(",")[0].trim() || "anonymous";
}

function allowedByRateLimit(request, env) {
  const configuredLimit = Number(env.RATE_LIMIT_PER_MINUTE || 60);
  if (!Number.isInteger(configuredLimit) || configuredLimit <= 0) return true;
  const now = Date.now();
  const windowStart = Math.floor(now / 60000) * 60000;
  const key = requestIdentity(request) + ":" + windowStart;
  for (const bucketKey of rateBuckets.keys()) {
    if (Number(bucketKey.slice(bucketKey.lastIndexOf(":") + 1)) < windowStart) rateBuckets.delete(bucketKey);
  }
  const count = rateBuckets.get(key) || 0;
  if (count >= configuredLimit) return false;
  rateBuckets.set(key, count + 1);
  return true;
}

function requiresApiKey(request, env) {
  const expected = String(env.CORE_AGENT_API_KEY || "").trim();
  if (["bailian", "aliyun_bailian"].includes(String(env.MODEL_PROVIDER || "").trim().toLowerCase()) && !expected) return false;
  return !expected || request.headers.get("X-Core-Agent-Key") === expected;
}

function workflowErrorPayload(error) {
  const record = error.workflowRecord || error.record || null;
  const requestId = record?.request_id || error.requestId || null;
  return coreError.decorate({
    review_version: modelReview.REVIEW_VERSION,
    contract_version: modelReview.REVIEW_VERSION,
    error: {
      code: error.code || "WORKFLOW_FAILED",
      message: error.message || "workflow failed",
      retryable: Boolean(error.retryable),
      stage: error.stage || "WORKFLOW",
      recovery: error.recovery || "Review the task state and retry.",
      details: error.details || null
    },
    workflow: record
  }, {
    sourceContractVersion: modelReview.REVIEW_VERSION,
    requestId,
    taskId: record?.task_id || error.taskId || null,
    sessionId: error.sessionId || null,
    runId: record?.run_id || error.runId || null,
    auditId: record?.audit?.audit_id || error.auditId || null,
    handoffId: record?.risk_handoff?.handoff_id || error.handoffId || null,
    operation: "MODEL_REVIEW",
    legacyContractVersion: modelReview.REVIEW_VERSION
  });
}

// One durable coordinator keeps demo workflow updates ordered and audit reads
// consistent across edge locations and Worker restarts.
export class ReviewService {
  constructor(state, env) {
    this.storage = state.storage;
    this.env = env;
    this.queue = Promise.resolve();
    this.modelBuckets = new Map();
    this.bailianBudget = new bailianBudgetModule.BailianBudget({ storage: this.storage, env });
    this.reservations = new reviewReservationModule.ReviewReservations(this.storage);
    this.transitions = new reviewTransitionModule.ReviewTransitions(this.storage);
    this.pendingRequests = 0;
  }

  fetch(request) {
    const bailian = ["bailian", "aliyun_bailian"].includes(String(this.env.MODEL_PROVIDER || "").trim().toLowerCase());
    if (bailian && this.pendingRequests >= 8) return Promise.resolve(json(request, this.env, 429, errorPayload(rateLimitFailure()), { "Retry-After": "60" }));
    this.pendingRequests++;
    const pending = this.queue.then(() => this.handle(request)).finally(() => { this.pendingRequests--; });
    this.queue = pending.catch(() => {});
    return pending;
  }

  async persist(record, fundingPlans = null, reservation = null, transition = null) {
    if (!record?.run_id) return;
    const entries = {
      ["run:" + record.run_id]: record,
      ["task:" + record.task_id]: record.run_id,
      ...this.reservations.completedEntries(reservation, record),
      ...this.transitions.completedEntries(transition, record)
    };
    if (record.idempotency_key) entries["idempotency:" + record.idempotency_key] = record.run_id;
    // One atomic storage operation commits both the simulation receipt and its allocation.
    for (const plan of fundingPlans?.plans.values() || []) entries["funding:" + plan.plan_id] = plan;
    await this.storage.put(entries);
  }

  async loadFundingPlan(store, planId) {
    if (typeof planId !== "string") return;
    await this.transitions.assertPlan(planId);
    const plan = await this.storage.get("funding:" + planId);
    if (plan) store.save(plan);
  }

  async lookupTask(taskId) {
    await this.transitions.assertTask(taskId);
    const runId = await this.storage.get("task:" + taskId);
    const record = runId ? await this.storage.get("run:" + runId) : null;
    await this.transitions.assertRecord(record);
    return record;
  }

  async lookupIdempotency(key) {
    if (!key) return null;
    const runId = await this.storage.get("idempotency:" + key);
    const record = runId ? await this.storage.get("run:" + runId) : null;
    await this.transitions.assertRecord(record);
    return record;
  }

  async handle(request) {
    const env = this.env;
    const url = new URL(request.url);
    const fundingPlans = new FundingPlanStore();
    let reservation = null;
    let transition = null, transitionRecord = null, committing = false;
    try {
      if (request.method === "GET" && url.pathname.startsWith("/api/funding-demo/plan/")) {
        const planId = decodeURIComponent(url.pathname.slice("/api/funding-demo/plan/".length));
        await this.loadFundingPlan(fundingPlans, planId);
        return json(request, env, 200, fundingPlans.summary(planId));
      }
      if (request.method === "GET") {
        const handoffRequested = url.pathname.endsWith("/risk-handoff");
        const key = decodeURIComponent(url.pathname.slice("/api/review/".length, handoffRequested ? -"/risk-handoff".length : undefined));
        const result = key.startsWith("task/") ? await this.lookupTask(key.slice(5)) : await this.storage.get("run:" + key);
        await this.transitions.assertRecord(result);
        if (!result && key.startsWith("task/")) {
          const reserved = await this.reservations.byTask(key.slice(5));
          if (reserved) throw reviewReservationModule.unavailable(reserved);
        }
        return json(request, env, result ? 200 : 404, result ? (handoffRequested ? riskHandoff.buildRiskHandoffPackage(result) : result) : { error: { code: "REVIEW_NOT_FOUND", message: "没有找到这个运行编号。" } });
      }
      const body = await readJson(request);
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        throw new modelReview.ReviewError("INVALID_REVIEW_INPUT", "请求正文必须是 JSON 对象。", { statusCode: 422, stage: "VALIDATION" });
      }
      if (url.pathname === "/api/review" || url.pathname === "/api/review/legacy") {
        if (!body.request_id && request.headers.get("X-Request-ID")) body.request_id = request.headers.get("X-Request-ID");
        if (!body.idempotency_key && request.headers.get("Idempotency-Key")) body.idempotency_key = request.headers.get("Idempotency-Key");
      }
      if (["/api/funding-demo/plan", "/api/funding-demo/plan/revise"].includes(url.pathname)) {
        await this.loadFundingPlan(fundingPlans, body.plan_id);
        const plan = url.pathname.endsWith("/revise") ? fundingPlans.revise(body) : fundingPlans.create(body);
        if (url.pathname.endsWith("/revise")) transition = await this.transitions.begin({ operation: url.pathname, body, planId: plan.plan_id });
        committing = true;
        await this.storage.put({ ["funding:" + plan.plan_id]: fundingPlans.require(plan.plan_id), ...this.transitions.completedEntries(transition) });
        return json(request, env, 200, plan);
      }
      const workflow = new ReviewWorkflowStore({ fundingPlans });
      let result;
      if (["/api/review", "/api/review/legacy"].includes(url.pathname)) {
        const input = url.pathname === "/api/review/legacy"
          ? legacyReviewAdapter.normalizeLegacyReviewInput(body)
          : modelReview.normalizeReviewInput(body);
        if (input.idempotency_key) {
          const existing = await this.lookupIdempotency(input.idempotency_key);
          if (existing) {
            const same = await matchesRequestFingerprint(existing, input) || await this.reservations.matchesCompleted(existing, input);
            if (same) return json(request, env, 200, url.pathname === "/api/review/legacy" ? legacyReviewAdapter.mapWorkflowToLegacyResponse(existing) : existing);
            throw new WorkflowError("IDEMPOTENCY_CONFLICT", "idempotency key is already bound to different review input", {
              statusCode: 409, stage: "VALIDATION", recovery: "Reuse the original request body or create a new idempotency key.", record: existing
            });
          }
        }
        if (input.task_id && await this.lookupTask(input.task_id)) {
          throw new WorkflowError("TASK_ALREADY_EXISTS", "task_id already exists; load its record or create a new task", {
            statusCode: 409,
            stage: "VALIDATION",
            recovery: "Use the existing task record or create a new task_id."
          });
        }
        await this.reservations.assertAvailable(input);
        const minute = Math.floor(Date.now() / 60000);
        for (const [ip, bucket] of this.modelBuckets) if (bucket.minute !== minute) this.modelBuckets.delete(ip);
        const ip = requestIdentity(request);
        const bucket = this.modelBuckets.get(ip) || { minute, count: 0 };
        if (bucket.count >= Number(env.MODEL_REQUESTS_PER_MINUTE || 6)) {
          return json(request, env, 429, errorPayload(rateLimitFailure()), { "Retry-After": "60" });
        }
        bucket.count++;
        this.modelBuckets.set(ip, bucket);
        await this.loadFundingPlan(fundingPlans, input.action_parameters?.funding_plan_id);
        // Validate the existing funding binding before reserving an inference.
        fundingPlans.bind(input.action_parameters);
        reservation = await this.reservations.reserve(input);
        input.task_id = reservation.task_id;
        input.request_id = reservation.request_id;
        input.session_id = reservation.session_id;
        const usageHooks = this.bailianBudget.hooks();
        result = await workflow.start(input, env, {
          ...usageHooks,
          afterModelAttempt: async attempt => {
            const evidence = await usageHooks.afterModelAttempt(attempt);
            console.log(JSON.stringify({ event: "bailian.attempt", ...evidence }));
          }
        });
      } else {
        const method = {
          "/api/review/risk-decision": "decideRisk",
          "/api/review/risk-callback": "receiveRiskCallback",
          "/api/review/approval": "decideApproval",
          "/api/review/risk-dispatch": "dispatchRiskHandoff",
          "/api/review/simulate": "simulate",
          "/api/review/cancel": "cancel"
        }[url.pathname];
        if (!method) return json(request, env, 404, errorPayload(routeNotFoundFailure()));
        let actorAuth = null;
        if (["decideRisk", "receiveRiskCallback"].includes(method)) actorAuth = await ownerBridge.verifyOwnerRequest({ owner: "risk", body, headers: request.headers, env });
        if (method === "decideApproval") actorAuth = await ownerBridge.verifyOwnerRequest({ owner: "approval", body, headers: request.headers, env });
        const record = await this.lookupTask(body.task_id);
        if (record) workflow.save(record);
        await this.loadFundingPlan(fundingPlans, record?.proposed_action?.funding?.plan_id);
        if (record) {
          transitionRecord = record;
          transition = await this.transitions.begin({ operation: url.pathname, body, record,
            planId: method === "simulate" ? record.proposed_action?.funding?.plan_id || null : null });
        }
        if (url.pathname === "/api/review/risk-callback") {
          const callback = await workflow.receiveRiskCallback(body, actorAuth);
          committing = true;
          await this.persist(callback.workflow, fundingPlans, null, transition);
          return json(request, env, 200, { callback_version: riskHandoff.CALLBACK_VERSION, ...callback, handoff: riskHandoff.buildRiskHandoffPackage(callback.workflow) });
        }
        if (url.pathname === "/api/review/risk-decision") {
          result = await workflow.decideRisk(body, actorAuth);
        } else if (url.pathname === "/api/review/approval") {
          result = await workflow.decideApproval(body, actorAuth);
        } else if (url.pathname === "/api/review/risk-dispatch") {
          result = await workflow.dispatchRiskHandoff(body, handoff => ownerBridge.dispatchRiskHandoff(handoff, env));
        } else if (method) {
          result = await workflow[method](body);
        }
      }
      committing = true;
      await this.persist(result, fundingPlans, reservation, transition);
      return json(request, env, 200, url.pathname === "/api/review/legacy"
        ? legacyReviewAdapter.mapWorkflowToLegacyResponse(result)
        : result);
    } catch (error) {
      // A storage error can occur after a commit. Never retry it by writing an old snapshot.
      if (committing && (transition || reservation)) return json(request, env, 503,
        workflowErrorPayload(transition ? reviewTransitionModule.unavailable(transition) : reviewReservationModule.unavailable(reservation)));
      if (error.name === "ReviewError" || error.name === "WorkflowError") {
        try { await this.persist(error.workflowRecord || error.record || (transition ? transitionRecord : null), fundingPlans, reservation, transition); }
        catch { return json(request, env, 503, workflowErrorPayload(transition ? reviewTransitionModule.unavailable(transition) : reviewReservationModule.unavailable(reservation))); }
        return json(request, env, error.statusCode || 502, workflowErrorPayload(error));
      }
      if (error.code === "INVALID_JSON") return json(request, env, 400, errorPayload(error));
      if (transition) return json(request, env, 503, workflowErrorPayload(reviewTransitionModule.unavailable(transition)));
      if (reservation) return json(request, env, 503, workflowErrorPayload(reviewReservationModule.unavailable(reservation)));
      return json(request, env, 503, errorPayload(serviceUnavailableFailure()));
    }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      if (!originFor(request, env)) return new Response(null, { status: 403 });
      return new Response(null, { status: 204, headers: headers(request, env) });
    }
    if (request.method === "GET" && url.pathname === "/health") {
      const config = modelReview.resolveModelConfig(env);
      return json(request, env, 200, {
        status: "ok", service: "core-agent", contract_version: contract.CONTRACT_VERSION,
        review_endpoint: "/api/review", docs: "/docs",
        model: { provider: config.provider, name: config.model, configured: config.style === "workers_ai" ? typeof env.AI?.run === "function" : Boolean(config.apiKey && config.model && !config.configurationIssue) },
        audit_storage: env.REVIEW_SERVICE ? "durable_object" : "unconfigured"
      });
    }
    if (request.method === "GET" && ["/docs", "/api/review"].includes(url.pathname)) {
      return new Response(reviewDocs, { headers: {
        ...headers(request, env, "text/html; charset=utf-8"),
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"
      } });
    }
    if (request.method === "GET" && url.pathname === "/") {
      return json(request, env, 200, {
        service: "Personal AI Fund Manager Core Agent",
        contract_version: contract.CONTRACT_VERSION,
        endpoint: "/api/risk-workbench/handoff",
        review_endpoint: "/api/review",
        docs: "/docs",
        execution_allowed: false
      });
    }
    const isCapabilitiesRead = request.method === "GET" && url.pathname === "/api/review/capabilities";
    const isReviewRead = request.method === "GET" && (url.pathname.startsWith("/api/review/") || url.pathname.startsWith("/api/funding-demo/plan/"));
    const isKnownPost = request.method === "POST" && [
      "/api/health-check/run", "/api/risk-workbench/handoff", "/api/review", "/api/review/legacy",
      "/api/review/risk-decision", "/api/review/risk-callback", "/api/review/approval", "/api/review/risk-dispatch", "/api/review/simulate", "/api/review/cancel",
      "/api/funding-demo/plan", "/api/funding-demo/plan/revise"
    ].includes(url.pathname);
    if (!isKnownPost && !isReviewRead && !isCapabilitiesRead) {
      return json(request, env, 404, errorPayload(routeNotFoundFailure()));
    }
    if (!requiresApiKey(request, env)) return json(request, env, 401, errorPayload(authFailure()), { "WWW-Authenticate": "X-Core-Agent-Key" });
    if (!allowedByRateLimit(request, env)) return json(request, env, 429, errorPayload(rateLimitFailure()), { "Retry-After": "60" });
    if (isCapabilitiesRead) return json(request, env, 200, capabilityStatus(env));
    if (url.pathname === "/api/review" || url.pathname.startsWith("/api/review/") || url.pathname.startsWith("/api/funding-demo/")) {
      try {
        const service = env.REVIEW_SERVICE.get(env.REVIEW_SERVICE.idFromName("team-review-v1"));
        return await service.fetch(request);
      } catch {
        return json(request, env, 503, errorPayload(serviceUnavailableFailure()));
      }
    }
    let body;
    try {
      body = await readJson(request);
      const input = url.pathname === "/api/risk-workbench/handoff" ? (body.request || body) : body;
      const agentResponse = harness.runHealthCheckContract(input);
      if (url.pathname === "/api/health-check/run") return json(request, env, 200, agentResponse);
      return json(request, env, 200, {
        integration_version: "core-agent-to-risk-workbench.cloudflare@0.1.0",
        agent_response: agentResponse,
        risk_workbench: buildRiskWorkbenchHandoff(agentResponse)
      });
    } catch (error) {
      if (error?.name === "ReviewError") {
        return json(request, env, error.statusCode || 502, error.workflowRecord ? workflowErrorPayload(error) : modelReview.buildReviewError(error));
      }
      if (error?.name === "WorkflowError") return json(request, env, error.statusCode || 409, workflowErrorPayload(error));
      const requestId = body?.request?.request_id || body?.request_id || null;
      return json(request, env, error.statusCode || (error.code === "INVALID_PORTFOLIO" ? 422 : 400), errorPayload(error, requestId));
    }
  }
};
