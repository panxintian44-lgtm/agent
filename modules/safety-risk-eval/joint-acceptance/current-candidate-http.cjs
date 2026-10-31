"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { createHash, randomBytes, randomUUID } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const { normalizeConversationFinance } = require("../interface-adapters/conversation-input.cjs");
const { assessConversation } = require("../interface-adapters/conversation-risk.cjs");
const { buildRiskCallbackDraft, extractCoreBinding } = require("../interface-adapters/risk-callback.cjs");
const { sendRiskCallback, sendSimulationCallback } = require("../interface-adapters/risk-callback-sender.cjs");
const { signatureFor } = require("../../../chenchen/integrations/owner-bridge.js");

const ROOT = path.resolve(__dirname, "../../..");
const MODEL_LABEL = "LOCAL_HTTP_MODEL_TEST_DOUBLE_NOT_LIVE";
const APPROVAL_LABEL = "SIGNED_SERVICE_TEST_DOUBLE_NOT_AUTHENTICATED_END_USER";
const BINDINGS = ["handoff_id", "task_id", "request_id", "run_id", "audit_id", "proposal_sha256"];
const SOURCE_PATHS = [
  "chenchen/deployment/worker.js", "chenchen/integrations/owner-bridge.js",
  "chenchen/integrations/review-workflow.js", "chenchen/integrations/review-reservation.js",
  "chenchen/integrations/risk-handoff.js", "chenchen/integrations/review-transition.js", "chenchen/integrations/funding-plan.js",
  "modules/safety-risk-eval/daily-engine.cjs",
  "modules/safety-risk-eval/unified-rating/assessment.cjs", "modules/safety-risk-eval/unified-rating/daily-result-validation.cjs",
  "modules/safety-risk-eval/unified-rating/runtime-config.v1.1.json", "modules/safety-risk-eval/unified-rating/dependency-map.v1.1.json",
  "docs/safety-risk-eval/daily-policy-v1/policy-config.v1.json", "docs/safety-risk-eval/unified-rating-v1/risk-policy.json",
  "modules/safety-risk-eval/interface-adapters/conversation-input.cjs", "modules/safety-risk-eval/interface-adapters/money.cjs",
  "modules/safety-risk-eval/interface-adapters/risk-callback.cjs",
  "modules/safety-risk-eval/interface-adapters/conversation-risk.cjs",
  "modules/safety-risk-eval/interface-adapters/risk-callback-sender.cjs",
  "modules/safety-risk-eval/joint-acceptance/current-candidate-http.cjs"
];

function sourceManifest() {
  const git = (...args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8", windowsHide: true }).trim();
  return { git_head: git("rev-parse", "HEAD"), working_tree_changes: git("status", "--porcelain").split(/\r?\n/).filter(Boolean),
    core_import: "CURRENT_FULL_WORKER_DIRECT_IMPORT_NO_PINNED_OLD_SNAPSHOT",
    files: SOURCE_PATHS.map(file => ({ path: file, sha256: createHash("sha256").update(fs.readFileSync(path.join(ROOT, file))).digest("hex") })) };
}

function financeInput(amount = "2000") {
  return { cash_yuan: "10000", amount_yuan: amount, fees_yuan: "0", holds_yuan: "0", floor_yuan: "0",
    purpose_yuan: "4000", due_yuan: "4000", due_date: "2099-11-01", purpose_label: "房租", facts_confirmed: true, purpose_confirmed: true };
}

async function createContext(name) {
  const { default: worker, ReviewService } = await import(pathToFileURL(path.join(ROOT, "chenchen/deployment/worker.js")).href);
  const rows = new Map(), httpSteps = [], intents = [], outcomes = [];
  const credentials = { machine: randomBytes(32).toString("hex"), risk: randomBytes(32).toString("hex"), approval: randomBytes(32).toString("hex") };
  const failures = { model: false, resultWrite: false };
  const counts = { model_test_double: 0, risk_callback_http: 0, approval_http: 0, simulate_http: 0, result_receipt_writes: 0 };
  const reviewer = "synthetic-http-risk-owner", approver = "synthetic-http-approval-service";
  const env = {
    MODEL_PROVIDER: "workers_ai", MODEL_NAME: MODEL_LABEL, MODEL_MAX_ATTEMPTS: "1", MODEL_REQUESTS_PER_MINUTE: "100",
    MODEL_DISABLE_RULE_FALLBACK: "true", RATE_LIMIT_PER_MINUTE: "0", REQUIRE_TRUSTED_ACTORS: "true", REQUIRE_RISK_REVIEWER: "true",
    CORE_AGENT_API_KEY: credentials.machine, RISK_SERVICE_HMAC_SECRET: credentials.risk, RISK_REVIEWER_ID: reviewer,
    APPROVAL_SERVICE_HMAC_SECRET: credentials.approval,
    AI: { run: async () => {
      counts.model_test_double++;
      if (failures.model) throw new Error("SYNTHETIC_MODEL_UNAVAILABLE");
      return { id: "synthetic-provider-" + randomUUID(), response: { summary: MODEL_LABEL, proposed_action: "HOLD_FOR_REVIEW", risk_level: "medium",
        action_reason: "A synthetic proposal; the independent financial rules determine the callback.", evidence: [], missing_information: [] } };
    } }
  };
  const storage = { get: async key => structuredClone(rows.get(key)), put: async entries => {
    if (failures.resultWrite && Object.values(entries).some(row => row?.execution?.receipt)) {
      failures.resultWrite = false;
      throw new Error("SYNTHETIC_RESULT_WRITE_FAILURE");
    }
    for (const [key, value] of Object.entries(entries)) {
      if (value?.execution?.receipt) counts.result_receipt_writes++;
      rows.set(key, structuredClone(value));
    }
  } };
  let service = new ReviewService({ storage }, env);
  env.REVIEW_SERVICE = { idFromName: value => value, get: () => service };
  const server = http.createServer(async (request, response) => {
    try {
      const chunks = []; let size = 0;
      for await (const chunk of request) { size += chunk.length; assert.ok(size <= 128 * 1024); chunks.push(chunk); }
      const route = request.url;
      if (request.method === "POST") {
        if (route === "/api/review/risk-callback") counts.risk_callback_http++;
        if (route === "/api/review/approval") counts.approval_http++;
        if (route === "/api/review/simulate") counts.simulate_http++;
      }
      const options = { method: request.method, headers: request.headers };
      if (!["GET", "HEAD"].includes(request.method)) options.body = Buffer.concat(chunks);
      const result = await worker.fetch(new Request("http://127.0.0.1" + route, options), env);
      const bytes = Buffer.from(await result.arrayBuffer());
      let data; try { data = JSON.parse(bytes); } catch { data = null; }
      httpSteps.push({ method: request.method, path: route, status: result.status, error_code: data?.error?.code ?? null });
      response.writeHead(result.status, Object.fromEntries(result.headers)); response.end(bytes);
    } catch {
      response.writeHead(500, { "Content-Type": "application/json" }); response.end('{"error":{"code":"LOCAL_HTTP_HARNESS_FAILURE"}}');
    }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = "http://127.0.0.1:" + server.address().port;
  async function request(route, body, { owner = null, signature = "valid" } = {}) {
    const headers = { "X-Core-Agent-Key": credentials.machine, Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (owner && signature !== "missing") headers[owner === "risk" ? "X-Risk-Signature" : "X-Approval-Signature"] =
      await signatureFor(body, signature === "valid" ? credentials[owner] : "synthetic-invalid-secret");
    const result = await fetch(origin + route, { method: body === undefined ? "GET" : "POST", headers, redirect: "manual",
      signal: AbortSignal.timeout(5000), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: result.status, body: await result.json() };
  }
  async function ok(route, body, options) { const result = await request(route, body, options); assert.equal(result.status, 200, JSON.stringify(result)); return result.body; }
  async function denied(route, body, codes, options) {
    const result = await request(route, body, options);
    assert.ok(result.status >= 400, "Rejected requests cannot produce successful HTTP responses.");
    assert.ok(codes.includes(result.body.error?.code), JSON.stringify(result));
    return result;
  }
  async function record(run) { return ok("/api/review/task/" + encodeURIComponent(run.binding.task_id)); }
  async function noReceipt(run) {
    const stored = await record(run);
    assert.equal(stored.execution.receipt, null); assert.equal(stored.execution.execution_allowed, false);
    assert.equal(stored.execution.simulation_allowed, false);
    return stored;
  }
  return { name, origin, reviewer, approver, credentials, env, rows, failures, counts, intents, outcomes, httpSteps,
    request, ok, denied, record, noReceipt, restart() { service = new ReviewService({ storage }, env); },
    close: async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); },
    assertNoSecrets(value) { for (const secret of Object.values(credentials)) assert.ok(!JSON.stringify(value).includes(secret), "Report must not contain credentials."); }
  };
}

async function start(ctx, { amount = "2000", capability = "SIMULATION_ONLY", session = "synthetic-session-" + randomUUID(), key = "synthetic-key-" + randomUUID() } = {}) {
  const checkedAt = new Date().toISOString(), input = financeInput(amount), dailyFinance = normalizeConversationFinance(input, checkedAt);
  const assessment = assessConversation({ question: `虚构本地案例：投资${amount}元，需保留4000元房租。`, dailyFinance,
    now: checkedAt, checkId: "synthetic-risk-check-" + randomUUID() });
  const plan = await ctx.ok("/api/funding-demo/plan", { synthetic: true, confirmed: true, currency: "CNY", cash_minor: 1000000,
    protected_purposes: [{ purpose_id: "synthetic-rent", label: "房租", amount_minor: 400000 }] });
  const modelRequest = { schema_version: "model-review.v1", kind: "combined", text: MODEL_LABEL + ": rent-protected financial allocation",
    capability, execution_mode: "PAPER", data_mode: "SYNTHETIC_REPLAY", allow_rule_fallback: false, memory_consent: false,
    session_id: session, policy_version: assessment.risk_result.policy_version, idempotency_key: key,
    action_parameters: { synthetic: true, currency: "CNY", amount: dailyFinance.action.amount_minor / 100, funding_plan_id: plan.plan_id,
      funding_plan_revision: plan.revision }, context: { synthetic: true, instruction_authority: false, deterministic_risk: assessment.model_context } };
  const task = await ctx.ok("/api/review", modelRequest);
  const handoff = await ctx.ok("/api/review/" + encodeURIComponent(task.run_id) + "/risk-handoff");
  const binding = extractCoreBinding(handoff);
  assert.equal(task.task_id, binding.task_id); assert.equal(task.run_id, binding.run_id); assert.equal(task.audit.audit_id, binding.audit_id);
  assert.equal(handoff.session_id, session); assert.equal(handoff.proposal.funding.amount_minor, dailyFinance.action.amount_minor);
  const risk = assessment.risk_result;
  const draft = buildRiskCallbackDraft({ handoff, reviewer: ctx.reviewer, risk_result: { risk_check_id: risk.risk_check_id,
    decision: risk.decision, check_complete: risk.check_complete, checked_at: risk.checked_at, policy_version: risk.policy_version,
    core_binding: binding, local_task_id: ctx.name, reasons: risk.reasons.map(({ rule_id, code, message_zh, status }) => ({ rule_id, code, message_zh, status })) } });
  return { task, handoff, binding, assessment, draft, input, modelRequest, plan };
}

async function callback(ctx, run, { fetchImpl = fetch, persistIntent = async row => { ctx.intents.push(row); }, persistOutcome = async row => { ctx.outcomes.push(row); } } = {}) {
  const sender = run.handoff.capability === "SIMULATION_ONLY" ? sendSimulationCallback : sendRiskCallback;
  return sender({ draft: run.draft,
    loadCurrent: async () => ({ handoff: await ctx.ok("/api/review/" + encodeURIComponent(run.task.run_id) + "/risk-handoff"),
      risk_check_id: run.assessment.risk_result.risk_check_id, policy_version: run.assessment.risk_result.policy_version,
      checked_at: run.assessment.risk_result.checked_at, versions_current: true }),
    persistIntent, persistOutcome, config: { baseUrl: ctx.origin, apiKey: ctx.credentials.machine, hmacSecret: ctx.credentials.risk,
      reviewer: ctx.reviewer, timeoutMs: 1000, allowLocalHttp: true }, fetchImpl });
}

const simulateBody = run => ({ task_id: run.binding.task_id, proposal_sha256: run.binding.proposal_sha256 });
const approvalBody = (ctx, run, decision = "APPROVE") => ({ ...simulateBody(run), decision, approver: ctx.approver, reason: APPROVAL_LABEL });
const approve = (ctx, run, decision) => ctx.ok("/api/review/approval", approvalBody(ctx, run, decision), { owner: "approval" });

async function proof(ctx, run, extra = {}) {
  const stored = await ctx.record(run);
  assert.equal(stored.task_id, run.binding.task_id); assert.equal(stored.run_id, run.binding.run_id);
  assert.equal(stored.session_id, run.handoff.session_id); assert.equal(stored.audit.audit_id, run.binding.audit_id);
  assert.equal(stored.proposed_action.proposal_sha256, run.binding.proposal_sha256);
  assert.equal(stored.execution.execution_allowed, false);
  if (stored.risk_callback) for (const field of BINDINGS) assert.equal(stored.risk_callback.request[field], run.binding[field]);
  for (const event of stored.audit.events.filter(event => event.actor)) {
    assert.equal(event.task_id, stored.task_id); assert.equal(event.payload.trace.task_id, stored.task_id);
    assert.equal(event.payload.trace.run_id, stored.run_id); assert.equal(event.payload.trace.audit_id, stored.audit.audit_id);
  }
  const plan = await ctx.ok("/api/funding-demo/plan/" + encodeURIComponent(run.plan.plan_id));
  if (stored.execution.receipt === null) assert.equal(plan.allocations.length, 0, "Stopped tasks must not allocate simulated funds.");
  const result = { case_id: ctx.name, result: "PASS", trace: { ...run.binding, session_id: run.handoff.session_id },
    synthetic_financial_input: run.input, model: { label: MODEL_LABEL, actual_returned_content: stored.model.model_response.raw_text,
      proposed_action: stored.proposed_action }, risk: { decision: run.assessment.risk_result.decision,
      policy_version: run.assessment.risk_result.policy_version, reasons: run.assessment.risk_result.reasons },
    callback_intents: ctx.intents, callback_outcomes: ctx.outcomes, approval: stored.approval, execution: stored.execution,
    audit_events: stored.audit.events, funding_plan: plan, http_steps: ctx.httpSteps, call_counts: { ...ctx.counts },
    simulated_receipt_count: stored.execution.receipt === null ? 0 : 1, simulated_allocation_count: plan.allocations.length,
    real_model_calls: 0, real_financial_operations: 0, ...extra };
  ctx.assertNoSecrets(result); return result;
}

async function runCurrentCandidateHttp() {
  const source = sourceManifest(), cases = [], failures = [];
  async function check(name, operation) {
    let ctx;
    try { ctx = await createContext(name); cases.push(await operation(ctx)); }
    catch (error) { failures.push({ case_id: name, result: "FAIL", code: error.code || error.name, message: error.message.slice(0, 1800), http_steps: ctx?.httpSteps }); }
    finally { if (ctx) await ctx.close(); }
  }
  await check("signed_simulation_same_task_audit_and_duplicate_receipt", async ctx => {
    const run = await start(ctx); assert.equal(run.assessment.risk_result.decision, "ALLOW");
    await ctx.denied("/api/review/simulate", simulateBody(run), ["EXECUTION_BLOCKED"]);
    const risk = await callback(ctx, run); assert.equal(risk.status, "RECORDED");
    assert.equal(risk.receipt.auth.fixed_actor_verified, true);
    assert.equal(risk.receipt.auth.identity_scope, "SERVICE");
    assert.equal(risk.receipt.auth.end_user_identity_verified, false);
    await ctx.denied("/api/review/simulate", simulateBody(run), ["EXECUTION_BLOCKED"]);
    assert.equal((await approve(ctx, run)).approval.auth.verified, true);
    const first = await ctx.ok("/api/review/simulate", simulateBody(run));
    const replay = await ctx.ok("/api/review/simulate", simulateBody(run));
    assert.equal(first.status, "SIMULATED"); assert.equal(first.execution.receipt.side_effects, false);
    assert.deepEqual(first.execution.receipt, replay.execution.receipt); ctx.restart();
    const out = await proof(ctx, run);
    assert.equal(out.funding_plan.allocations.length, 1); assert.equal(out.call_counts.model_test_double, 1);
    assert.equal(out.audit_events.filter(event => event.event_type === "execution.simulated").length, 1); return out;
  });
  await check("readonly_signed_allow_and_confirmation_cannot_upgrade", async ctx => {
    const run = await start(ctx, { capability: "REVIEW_ONLY" }); assert.equal((await callback(ctx, run)).status, "RECORDED");
    await ctx.denied("/api/review/approval", approvalBody(ctx, run), ["SIMULATION_CAPABILITY_REQUIRED"], { owner: "approval" });
    await ctx.denied("/api/review/simulate", simulateBody(run), ["SIMULATION_CAPABILITY_REQUIRED", "EXECUTION_BLOCKED"]);
    await ctx.noReceipt(run); const out = await proof(ctx, run); assert.equal(out.funding_plan.allocated_minor, 0); return out;
  });
  await check("rent_conflict_deterministic_block", async ctx => {
    const run = await start(ctx, { amount: "8000" }); assert.equal(run.assessment.risk_result.decision, "BLOCK");
    assert.equal(run.assessment.risk_advice.metrics.shortfall_minor, 200000); assert.equal((await callback(ctx, run)).status, "RECORDED");
    await ctx.denied("/api/review/approval", approvalBody(ctx, run), ["WORKFLOW_TERMINAL", "APPROVAL_BLOCKED"], { owner: "approval" });
    await ctx.denied("/api/review/simulate", simulateBody(run), ["EXECUTION_BLOCKED"]); await ctx.noReceipt(run); return proof(ctx, run);
  });
  for (const signature of ["missing", "invalid"]) await check("risk_signature_" + signature, async ctx => {
    const run = await start(ctx);
    await ctx.denied("/api/review/risk-callback", run.draft.callback, [signature === "missing" ? "OWNER_AUTH_REQUIRED" : "OWNER_AUTH_INVALID"], { owner: "risk", signature });
    await ctx.noReceipt(run); assert.equal(ctx.counts.approval_http, 0); assert.equal(ctx.counts.simulate_http, 0);
    const out = await proof(ctx, run); assert.equal(out.callback_outcomes.length, 0); return out;
  });
  await check("signed_but_wrong_fixed_reviewer", async ctx => {
    const run = await start(ctx);
    await ctx.denied("/api/review/risk-callback", { ...run.draft.callback, reviewer: "synthetic-other-owner" }, ["OWNER_ACTOR_MISMATCH"], { owner: "risk" });
    await ctx.noReceipt(run); assert.equal(ctx.counts.approval_http, 0); assert.equal(ctx.counts.simulate_http, 0); return proof(ctx, run);
  });
  for (const signature of ["missing", "invalid"]) await check("approval_signature_" + signature, async ctx => {
    const run = await start(ctx); await callback(ctx, run);
    await ctx.denied("/api/review/approval", approvalBody(ctx, run), [signature === "missing" ? "OWNER_AUTH_REQUIRED" : "OWNER_AUTH_INVALID"], { owner: "approval", signature });
    await ctx.noReceipt(run); assert.equal(ctx.counts.simulate_http, 0); return proof(ctx, run);
  });
  await check("approval_missing_or_rejected", async ctx => {
    const run = await start(ctx); await callback(ctx, run);
    await ctx.denied("/api/review/simulate", simulateBody(run), ["EXECUTION_BLOCKED"]); await approve(ctx, run, "REJECT");
    await ctx.denied("/api/review/simulate", simulateBody(run), ["EXECUTION_BLOCKED"]); await ctx.noReceipt(run); return proof(ctx, run);
  });
  await check("approval_expired", async ctx => {
    const run = await start(ctx); await callback(ctx, run); const approved = await approve(ctx, run);
    // Only the local storage test adapter changes time; no public endpoint can set an expiry.
    approved.approval.expires_at = new Date(Date.now() - 1000).toISOString(); ctx.rows.set("run:" + run.binding.run_id, structuredClone(approved));
    await ctx.denied("/api/review/simulate", simulateBody(run), ["APPROVAL_EXPIRED"]); await ctx.noReceipt(run);
    const out = await proof(ctx, run); assert.equal(out.approval.status, "EXPIRED"); return out;
  });
  await check("approval_parameters_or_proposal_changed", async ctx => {
    const run = await start(ctx); await callback(ctx, run); await approve(ctx, run);
    await ctx.denied("/api/review/simulate", { ...simulateBody(run), amount: 3000 }, ["UNEXPECTED_ACTION_FIELDS"]);
    await ctx.denied("/api/review/simulate", { ...simulateBody(run), proposal_sha256: "f".repeat(64) }, ["PROPOSAL_CHANGED"]);
    const out = await proof(ctx, run); assert.equal(out.execution.receipt, null); assert.equal(out.funding_plan.allocated_minor, 0); return out;
  });
  await check("same_key_different_session_or_task_no_data_leak", async ctx => {
    const run = await start(ctx), same = await ctx.ok("/api/review", run.modelRequest);
    assert.equal(same.run_id, run.task.run_id);
    for (const changed of [{ session_id: "synthetic-other-session" }, { task_id: "synthetic-other-task" }]) {
      const rejected = await ctx.denied("/api/review", { ...run.modelRequest, ...changed }, ["IDEMPOTENCY_CONTEXT_MISMATCH"]);
      assert.equal(JSON.stringify(rejected.body).includes(run.task.run_id), false);
    }
    assert.equal(ctx.counts.model_test_double, 1); assert.equal(ctx.counts.risk_callback_http, 0);
    assert.equal(ctx.counts.approval_http, 0); assert.equal(ctx.counts.simulate_http, 0); await ctx.noReceipt(run); return proof(ctx, run);
  });
  await check("signed_cross_task_callback", async ctx => {
    const first = await start(ctx), second = await start(ctx);
    await ctx.denied("/api/review/risk-callback", { ...first.draft.callback, task_id: second.binding.task_id, run_id: second.binding.run_id }, ["RISK_HANDOFF_MISMATCH"], { owner: "risk" });
    await ctx.noReceipt(first); await ctx.noReceipt(second);
    assert.equal(ctx.counts.approval_http, 0); assert.equal(ctx.counts.simulate_http, 0);
    return proof(ctx, second, { rejected_source_binding: first.binding, identity_scope: "EXPLICIT_SYNTHETIC_CONTEXT_NOT_USER_LOGIN" });
  });
  await check("risk_service_disconnected", async ctx => {
    const run = await start(ctx);
    const closed = http.createServer(); await new Promise(resolve => closed.listen(0, "127.0.0.1", resolve));
    const unusedOrigin = "http://127.0.0.1:" + closed.address().port; await new Promise(resolve => closed.close(resolve));
    ctx.env.RISK_SERVICE_URL = unusedOrigin + "/synthetic-risk-handoff"; ctx.env.ALLOW_INSECURE_OWNER_URL = "true";
    await ctx.denied("/api/review/risk-dispatch", { task_id: run.binding.task_id, proposal_sha256: run.binding.proposal_sha256 }, ["OWNER_SERVICE_UNAVAILABLE"]);
    await ctx.noReceipt(run); assert.equal(ctx.counts.risk_callback_http, 0); assert.equal(ctx.counts.approval_http, 0); assert.equal(ctx.counts.simulate_http, 0);
    return proof(ctx, run);
  });
  await check("callback_intent_audit_failure_zero_network", async ctx => {
    const run = await start(ctx);
    await assert.rejects(callback(ctx, run, { persistIntent: async () => { throw new Error("SYNTHETIC_AUDIT_FAILURE"); } }), { code: "CALLBACK_INTENT_NOT_DURABLE" });
    await ctx.noReceipt(run); assert.equal(ctx.counts.risk_callback_http, 0); assert.equal(ctx.counts.approval_http, 0); assert.equal(ctx.counts.simulate_http, 0); return proof(ctx, run);
  });
  await check("callback_committed_response_lost_unknown_no_retry", async ctx => {
    const run = await start(ctx);
    const result = await callback(ctx, run, { fetchImpl: async (...args) => {
      const response = await fetch(...args); assert.equal(response.status, 200); await response.json(); throw new Error("SYNTHETIC_ACK_LOST");
    } });
    assert.equal(result.status, "UNKNOWN"); assert.equal(result.requires_reconciliation, true);
    await assert.rejects(callback(ctx, run), { code: "HANDOFF_NOT_PENDING" });
    assert.equal(ctx.counts.risk_callback_http, 1); assert.equal(ctx.counts.approval_http, 0); assert.equal(ctx.counts.simulate_http, 0);
    const stored = await ctx.noReceipt(run); assert.equal(stored.risk_decision.decision, "APPROVE");
    return proof(ctx, run, { callback_result: result, recovery: "RECONCILE_CORE_RECORD_BEFORE_ANY_RETRY" });
  });
  await check("simulation_result_storage_unknown_safe_stop", async ctx => {
    const run = await start(ctx); await callback(ctx, run); await approve(ctx, run); ctx.failures.resultWrite = true;
    const first = await ctx.request("/api/review/simulate", simulateBody(run));
    assert.equal(first.status, 503); assert.equal(first.body.error.code, "REVIEW_SERVICE_UNAVAILABLE");
    const repeat = await ctx.request("/api/review/simulate", simulateBody(run)); assert.equal(repeat.status, 503);
    const pending = [...ctx.rows.values()].filter(row => row?.transition_version && row.state === "PENDING");
    assert.ok(pending.some(row => row.task_id === run.binding.task_id && row.operation === "/api/review/simulate"));
    assert.equal(ctx.rows.get("funding:" + run.plan.plan_id).allocations.length, 0);
    const out = { case_id: ctx.name, result: "PASS", trace: run.binding, execution_result: "UNKNOWN", execution_allowed: false,
      original_error: first.body, repeated_error: repeat.body, pending_transition_records: pending, http_steps: ctx.httpSteps,
      call_counts: { ...ctx.counts }, persisted_simulated_receipts: ctx.counts.result_receipt_writes,
      persisted_simulated_allocations: ctx.rows.get("funding:" + run.plan.plan_id).allocations.length,
      real_model_calls: 0, real_financial_operations: 0 };
    assert.equal(out.persisted_simulated_receipts, 0); assert.equal(out.persisted_simulated_allocations, 0);
    ctx.assertNoSecrets(out); return out;
  });
  await check("protected_purpose_version_change_invalidates_execution", async ctx => {
    const run = await start(ctx); await callback(ctx, run); await approve(ctx, run);
    await ctx.ok("/api/funding-demo/plan/revise", { synthetic: true, confirmed: true, currency: "CNY", cash_minor: 1000000,
      protected_purposes: [{ purpose_id: "synthetic-rent", label: "房租", amount_minor: 500000 }], plan_id: run.plan.plan_id, expected_revision: 1 });
    await ctx.denied("/api/review/simulate", simulateBody(run), ["FUNDING_PLAN_CHANGED"]); await ctx.noReceipt(run); return proof(ctx, run);
  });
  return { report_version: "current-candidate-signed-http.v1", generated_at: new Date().toISOString(), environment: { platform: process.platform, node: process.version },
    source_manifest: source, scope: "CURRENT_FULL_CORE_WORKER_LOCAL_HTTP_AND_REAL_RISK_PROGRAM_ONLY", model: MODEL_LABEL, approval_identity: APPROVAL_LABEL,
    storage: "IN_MEMORY_DURABLE_OBJECT_TEST_ADAPTER_NOT_CLOUDFLARE_SQLITE", funding: "CORE_SYNTHETIC_FUNDING_PLAN_NOT_SHARED_FINANCE_LEDGER",
    network: "LOOPBACK_HTTP_ONLY", real_model_calls: 0, paid_model_calls: 0, real_financial_operations: 0, deployed: false,
    formal_joint_acceptance: false, release_status: "NO_GO_PENDING_STAGING_AND_AUTHENTICATED_USER_ACCEPTANCE",
    passed: cases.length, failed: failures.length, cases, failures };
}

if (require.main === module) runCurrentCandidateHttp().then(report => {
  const outputAt = process.argv.indexOf("--out");
  if (outputAt !== -1) {
    const output = path.resolve(process.argv[outputAt + 1]); fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, JSON.stringify(report, null, 2) + "\n", "utf8");
  }
  process.stdout.write(JSON.stringify({ passed: report.passed, failed: report.failed, scope: report.scope, failures: report.failures }, null, 2) + "\n");
  if (report.failed) process.exitCode = 1;
}).catch(error => { process.stderr.write(error.stack + "\n"); process.exitCode = 1; });

module.exports = { runCurrentCandidateHttp };
