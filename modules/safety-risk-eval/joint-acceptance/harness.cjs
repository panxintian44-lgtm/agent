"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const { randomBytes, randomUUID } = require("node:crypto");
const { pathToFileURL } = require("node:url");
const { normalizeConversationFinance } = require("../interface-adapters/conversation-input.cjs");
const { assessConversation } = require("../interface-adapters/conversation-risk.cjs");
const { buildRiskCallbackDraft, extractCoreBinding } = require("../interface-adapters/risk-callback.cjs");
const { assertHandoff } = require("../interface-adapters/core-client.cjs");
const { createConversationReviewer } = require("../interface-adapters/conversation-review.cjs");
const { ConversationStore, hash } = require("../interface-adapters/conversation-store.cjs");
const { signatureFor } = require("../../../chenchen/integrations/owner-bridge.js");

const MODEL_LABEL = "TEST_DOUBLE_NOT_LIVE";
const APPROVAL_LABEL = "SIGNED_SERVICE_TEST_DOUBLE_NOT_END_USER_LOGIN";

async function context(snapshot, name) {
  const { default: worker, ReviewService } = await import(pathToFileURL(path.join(snapshot.directory, "chenchen/deployment/worker.js")).href);
  const rows = new Map(), calls = [], failures = { model: false, persist: false };
  let modelCalls = 0;
  const credentials = { machine: randomBytes(32).toString("hex"), risk: randomBytes(32).toString("hex"), approval: randomBytes(32).toString("hex") };
  const reviewer = "synthetic-joint-risk-owner", approver = "synthetic-joint-approval-service";
  const env = {
    MODEL_PROVIDER: "workers_ai", MODEL_NAME: MODEL_LABEL, MODEL_MAX_ATTEMPTS: "1", MODEL_REQUESTS_PER_MINUTE: "100",
    RATE_LIMIT_PER_MINUTE: "0", REQUIRE_TRUSTED_ACTORS: "true", REQUIRE_RISK_REVIEWER: "true",
    CORE_AGENT_API_KEY: credentials.machine, RISK_SERVICE_HMAC_SECRET: credentials.risk, RISK_REVIEWER_ID: reviewer,
    APPROVAL_SERVICE_HMAC_SECRET: credentials.approval,
    AI: { run: async () => {
      modelCalls++;
      if (failures.model) throw new Error("SYNTHETIC_MODEL_FAILURE");
      return { id: `synthetic-model-${randomUUID()}`, response: {
        summary: MODEL_LABEL, proposed_action: "HOLD_FOR_REVIEW", risk_level: "medium",
        action_reason: "Synthetic proposal only; preserve the confirmed protected purpose.", evidence: [], missing_information: []
      } };
    } }
  };
  const storage = { get: async key => structuredClone(rows.get(key)), put: async entries => {
    if (failures.persist && Object.values(entries).some(row => row?.execution?.receipt)) {
      failures.persist = false;
      throw new Error("SYNTHETIC_RESULT_STORAGE_FAILURE");
    }
    for (const [key, value] of Object.entries(entries)) rows.set(key, structuredClone(value));
  } };
  const service = new ReviewService({ storage }, env);
  env.REVIEW_SERVICE = { idFromName: value => value, get: () => service };
  const server = http.createServer(async (request, response) => {
    try {
      const chunks = []; let size = 0;
      for await (const part of request) { size += part.length; if (size > 128 * 1024) throw new Error("Request too large."); chunks.push(part); }
      const options = { method: request.method, headers: request.headers };
      if (!["GET", "HEAD"].includes(request.method)) options.body = Buffer.concat(chunks);
      const upstream = await worker.fetch(new Request(`http://127.0.0.1${request.url}`, options), env);
      response.writeHead(upstream.status, Object.fromEntries(upstream.headers));
      response.end(Buffer.from(await upstream.arrayBuffer()));
    } catch { response.writeHead(500, { "Content-Type": "application/json" }); response.end('{"error":{"code":"HARNESS_FAILURE"}}'); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const journal = new ConversationStore(path.join(snapshot.directory, `journal-${name}`));
  async function request(route, body, { owner, valid = true } = {}) {
    const headers = { "X-Core-Agent-Key": credentials.machine, Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (owner) headers[owner === "risk" ? "X-Risk-Signature" : "X-Approval-Signature"] = await signatureFor(body, valid ? credentials[owner] : "deliberately-invalid-synthetic-secret");
    const response = await fetch(origin + route, { method: body === undefined ? "GET" : "POST", headers, redirect: "manual", signal: AbortSignal.timeout(5000), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data = await response.json();
    calls.push({ method: body === undefined ? "GET" : "POST", path: route, http_status: response.status, error_code: data.error?.code ?? null });
    return { status: response.status, data };
  }
  async function ok(route, body, options) { const result = await request(route, body, options); assert.equal(result.status, 200, JSON.stringify(result.data)); return result.data; }
  async function denied(route, body, codes, options) {
    const result = await request(route, body, options);
    assert.ok(result.status >= 400, "An invalid transition must be rejected.");
    assert.ok(codes.includes(result.data.error?.code), JSON.stringify(result));
    return result;
  }
  return { name, rows, calls, failures, journal, origin, reviewer, approver, credentials, request, ok, denied,
    modelCalls: () => modelCalls,
    close: async () => { journal.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); },
    assertNoSecrets: value => { for (const secret of Object.values(credentials)) assert.ok(!JSON.stringify(value).includes(secret), "Evidence must not contain a service credential."); }
  };
}

function financeInput(amount = "2000", purpose = "4000", label = "房租", fees = "0") {
  return { cash_yuan: "10000", amount_yuan: amount, fees_yuan: fees, holds_yuan: "0", floor_yuan: "0",
    purpose_yuan: purpose, due_yuan: purpose, due_date: "2099-11-01", purpose_label: label, facts_confirmed: true, purpose_confirmed: true };
}

async function start(ctx, { amount = "2000", purpose = "4000", label = "房租", fees = "0", plan = null } = {}) {
  const at = new Date().toISOString(), input = financeInput(amount, purpose, label, fees);
  const finance = normalizeConversationFinance(input, at), assessment = assessConversation({ question: `虚构案例：投资${amount}元，保留${purpose}元${label}。`, dailyFinance: finance, now: at, checkId: `joint-risk-${randomUUID()}` });
  if (!plan) plan = await ctx.ok("/api/funding-demo/plan", { synthetic: true, confirmed: true, currency: "CNY", cash_minor: finance.snapshot.cash_ledger_minor,
    protected_purposes: [{ purpose_id: "protected-purpose", label, amount_minor: finance.snapshot.purposes[0].reserved_now_minor }] });
  // The Core demo plan accepts yuan numbers. Reuse the exact converter before the bounded numeric boundary.
  const action = { synthetic: true, currency: "CNY", amount: finance.action.amount_minor / 100, funding_plan_id: plan.plan_id, funding_plan_revision: plan.revision,
    conversation_facts_sha256: hash(finance) };
  const modelRequest = { schema_version: "model-review.v1", kind: "combined", text: `虚构联调：${label}保护；${MODEL_LABEL}`,
    source: "risk-joint-acceptance-local", capability: "SIMULATION_ONLY", execution_mode: "PAPER", data_mode: "SYNTHETIC_REPLAY", allow_rule_fallback: false,
    memory_consent: false, policy_version: assessment.risk_result.policy_version, idempotency_key: `joint-${randomUUID()}`,
    action_parameters: action, context: { synthetic: true, instruction_authority: false, finance_snapshot_sha256: hash(finance), deterministic_risk: assessment.model_context } };
  const task = await ctx.ok("/api/review", modelRequest);
  const handoff = await ctx.ok(`/api/review/${encodeURIComponent(task.run_id)}/risk-handoff`);
  assertHandoff(handoff);
  const binding = extractCoreBinding(handoff);
  assert.equal(task.task_id, binding.task_id); assert.equal(task.run_id, binding.run_id); assert.equal(task.audit.audit_id, binding.audit_id);
  assert.equal(handoff.proposal.funding.revision, plan.revision);
  assert.equal(handoff.proposal.funding.amount_minor, finance.action.amount_minor);
  assert.deepEqual(handoff.reviewed_input.action_parameters, action);
  const risk = assessment.risk_result;
  const draft = buildRiskCallbackDraft({ handoff, reviewer: ctx.reviewer, risk_result: {
    risk_check_id: risk.risk_check_id, decision: risk.decision, check_complete: risk.check_complete, checked_at: risk.checked_at,
    policy_version: risk.policy_version, core_binding: binding, local_task_id: ctx.name,
    reasons: risk.reasons.map(({ rule_id, code, message_zh, status }) => ({ rule_id, code, message_zh, status }))
  } });
  ctx.journal.audit(ctx.name, "JOINT_RISK_CHECKED", { ...binding, risk_check_id: risk.risk_check_id, policy_version: risk.policy_version,
    facts_hash: hash(finance), plan_id: plan.plan_id, plan_revision: plan.revision, metrics: risk.metrics, decision: risk.decision, reasons: risk.reasons });
  return { task, handoff, binding, draft, finance, assessment, input, plan, modelRequest };
}

async function callback(ctx, run, options) {
  assert.ok(run.draft.callback);
  ctx.journal.audit(ctx.name, "JOINT_CALLBACK_INTENT", { ...run.binding, decision: run.draft.callback.decision });
  const receipt = await ctx.ok("/api/review/risk-callback", run.draft.callback, { owner: "risk", ...options });
  assert.equal(receipt.callback_status, "RECORDED");
  assert.equal(receipt.workflow.risk_decision.auth.verified, true);
  assert.equal(receipt.workflow.risk_decision.auth.actor, ctx.reviewer);
  for (const key of Object.keys(run.binding)) assert.equal(receipt.workflow.risk_callback.request[key], run.binding[key]);
  ctx.journal.audit(ctx.name, "JOINT_CALLBACK_RECORDED", { ...run.binding, risk_check_id: run.assessment.risk_result.risk_check_id, decision: receipt.workflow.risk_decision.decision });
  return receipt.workflow;
}

const simulationBody = run => ({ task_id: run.binding.task_id, proposal_sha256: run.binding.proposal_sha256 });
const approvalBody = (ctx, run, decision = "APPROVE") => ({ ...simulationBody(run), decision, approver: ctx.approver, reason: `${APPROVAL_LABEL}; synthetic plan confirmation only.` });
async function approve(ctx, run, decision = "APPROVE") { return ctx.ok("/api/review/approval", approvalBody(ctx, run, decision), { owner: "approval" }); }

async function evidence(ctx, run, extra = {}) {
  const task = await ctx.ok(`/api/review/task/${encodeURIComponent(run.binding.task_id)}`);
  assert.equal(task.task_id, run.binding.task_id); assert.equal(task.run_id, run.binding.run_id); assert.equal(task.audit.audit_id, run.binding.audit_id);
  assert.equal(task.proposed_action.proposal_sha256, run.binding.proposal_sha256);
  assert.equal(task.execution.execution_allowed, false);
  for (const event of task.audit.events.filter(event => event.actor)) {
    assert.equal(event.task_id, task.task_id);
    assert.equal(event.payload.trace.task_id, task.task_id);
    assert.equal(event.payload.trace.run_id, task.run_id);
    assert.equal(event.payload.trace.audit_id, task.audit.audit_id);
  }
  const plan = await ctx.ok(`/api/funding-demo/plan/${encodeURIComponent(run.plan.plan_id)}`);
  const out = { scenario_id: ctx.name, result: "PASS", source_mode: MODEL_LABEL, approval_identity: APPROVAL_LABEL,
    input: run.input, trace: run.binding, model_evidence: { label: MODEL_LABEL, raw_text: task.model.model_response.raw_text, proposed_action: task.proposed_action },
    risk: { risk_check_id: run.assessment.risk_result.risk_check_id, policy_version: run.assessment.risk_result.policy_version,
      decision: run.assessment.risk_result.decision, metrics: run.assessment.risk_advice.metrics, reasons: run.assessment.risk_result.reasons, next_actions: run.assessment.next_actions },
    risk_callback: task.risk_callback, approval: task.approval, workflow_status: task.status, execution: task.execution,
    funding_plan: plan, audit_events: task.audit.events, risk_audit_events: ctx.journal.events, http_steps: ctx.calls,
    model_test_double_calls: ctx.modelCalls(), real_model_calls: 0, ...extra };
  ctx.assertNoSecrets(out); return out;
}

async function runCase(snapshot, name, operation) {
  const ctx = await context(snapshot, name);
  try { return await operation(ctx); } finally { await ctx.close(); }
}

async function runLocalAcceptance(snapshot) {
  const cases = [], failures = [];
  async function check(name, operation) {
    try { cases.push(await runCase(snapshot, name, operation)); }
    catch (error) { failures.push({ scenario_id: name, result: "FAIL", code: error.code || error.name, message: error.message.slice(0, 1500) }); }
  }
  await check("normal_confirmed_plan", async ctx => {
    const run = await start(ctx); assert.equal(run.assessment.risk_result.decision, "ALLOW");
    await ctx.denied("/api/review/simulate", simulationBody(run), ["EXECUTION_BLOCKED"]);
    const risk = await callback(ctx, run); assert.equal(risk.status, "PENDING_APPROVAL"); assert.equal(risk.execution.receipt, null);
    await ctx.denied("/api/review/simulate", simulationBody(run), ["EXECUTION_BLOCKED"]);
    await ctx.denied("/api/review/approval", approvalBody(ctx, run), ["OWNER_AUTH_INVALID"], { owner: "approval", valid: false });
    const approved = await approve(ctx, run); assert.equal(approved.approval.auth.verified, true);
    const first = await ctx.ok("/api/review/simulate", simulationBody(run));
    const replay = await ctx.ok("/api/review/simulate", simulationBody(run));
    assert.equal(first.status, "SIMULATED"); assert.equal(first.execution.receipt.side_effects, false);
    assert.deepEqual(first.execution.receipt, replay.execution.receipt);
    const out = await evidence(ctx, run); assert.equal(out.funding_plan.allocations.length, 1);
    assert.equal(out.audit_events.filter(row => row.event_type === "execution.simulated").length, 1);
    assert.equal(ctx.modelCalls(), 1); return out;
  });
  for (const label of ["房租", "学费"]) await check(label === "房租" ? "rent_conflict" : "tuition_conflict", async ctx => {
    const run = await start(ctx, { amount: "8000", label }); assert.equal(run.assessment.risk_result.decision, "BLOCK");
    assert.equal(run.assessment.risk_advice.metrics.shortfall_minor, 200000);
    const risk = await callback(ctx, run); assert.equal(risk.status, "REJECTED");
    await ctx.denied("/api/review/approval", approvalBody(ctx, run), ["WORKFLOW_TERMINAL", "APPROVAL_BLOCKED"], { owner: "approval" });
    await ctx.denied("/api/review/simulate", simulationBody(run), ["EXECUTION_BLOCKED"]);
    const out = await evidence(ctx, run); assert.equal(out.execution.receipt, null); assert.equal(out.funding_plan.allocated_minor, 0); return out;
  });
  await check("confirmed_purpose_revision", async ctx => {
    const run = await start(ctx); await callback(ctx, run); await approve(ctx, run);
    const revised = await ctx.ok("/api/funding-demo/plan/revise", { synthetic: true, confirmed: true, currency: "CNY", cash_minor: 1000000,
      protected_purposes: [{ purpose_id: "protected-purpose", label: "房租", amount_minor: 500000 }], plan_id: run.plan.plan_id, expected_revision: 1 });
    assert.equal(revised.revision, 2);
    ctx.journal.audit(ctx.name, "JOINT_CONSTRAINT_REVISED", { ...run.binding, plan_id: revised.plan_id, previous_revision: 1, current_revision: 2 });
    await ctx.denied("/api/review/simulate", simulationBody(run), ["FUNDING_PLAN_CHANGED"]);
    const old = await evidence(ctx, run);
    assert.equal(old.execution.receipt, null); assert.equal(old.workflow_status, "FUNDING_BLOCKED"); assert.equal(old.funding_plan.allocated_minor, 0);
    // Preserve the historical approval; it must not grant authority over the changed plan.
    assert.equal(old.approval.status, "APPROVED");
    const replacement = await start(ctx, { purpose: "5000", plan: revised });
    assert.notEqual(replacement.binding.task_id, run.binding.task_id);
    const checked = await callback(ctx, replacement); assert.equal(checked.status, "PENDING_APPROVAL");
    await ctx.denied("/api/review/simulate", simulationBody(replacement), ["EXECUTION_BLOCKED"]);
    const replacementEvidence = await evidence(ctx, replacement);
    assert.equal(ctx.modelCalls(), 2); assert.equal(replacementEvidence.risk_callback.auth.verified, true);
    assert.equal(replacementEvidence.risk_callback.request.decision, "APPROVE");
    return { ...old, model_test_double_calls: ctx.modelCalls(), replacement: replacementEvidence };
  });
  await check("approval_rejected", async ctx => {
    const run = await start(ctx); await callback(ctx, run); await approve(ctx, run, "REJECT");
    await ctx.denied("/api/review/simulate", simulationBody(run), ["EXECUTION_BLOCKED"]);
    const out = await evidence(ctx, run); assert.equal(out.execution.receipt, null); assert.equal(out.funding_plan.allocated_minor, 0); return out;
  });
  await check("missing_fee_review", async ctx => {
    const run = await start(ctx, { fees: null }); assert.equal(run.assessment.risk_result.decision, "REVIEW");
    await callback(ctx, run);
    await ctx.denied("/api/review/approval", approvalBody(ctx, run), ["APPROVAL_BLOCKED"], { owner: "approval" });
    await ctx.denied("/api/review/simulate", simulationBody(run), ["EXECUTION_BLOCKED"]);
    const out = await evidence(ctx, run); assert.equal(out.execution.receipt, null); assert.equal(out.funding_plan.allocated_minor, 0); return out;
  });
  await check("wrong_signature_and_cross_task", async ctx => {
    const run = await start(ctx), other = await start(ctx);
    await ctx.denied("/api/review/risk-callback", run.draft.callback, ["OWNER_AUTH_INVALID"], { owner: "risk", valid: false });
    await ctx.denied("/api/review/risk-callback", { ...run.draft.callback, task_id: other.binding.task_id }, ["RISK_HANDOFF_MISMATCH"], { owner: "risk" });
    await ctx.denied("/api/review/simulate", simulationBody(run), ["EXECUTION_BLOCKED"]);
    const out = await evidence(ctx, run); assert.equal(out.risk_callback == null, true); assert.equal(out.execution.receipt, null); return out;
  });
  await check("readonly_capability", async ctx => {
    const config = { baseUrl: ctx.origin, apiKey: ctx.credentials.machine, hmacSecret: ctx.credentials.risk, reviewer: ctx.reviewer, allowLocalHttp: true, timeoutMs: 5000 };
    const reviewer = createConversationReviewer({ store: ctx.journal, config });
    const result = await reviewer.review({ question: "虚构：我想投入2000元，需保留4000元房租。", daily_finance_yuan: financeInput(), idempotency_key: "joint-readonly-case" });
    assert.equal(result.capability, "REVIEW_ONLY"); assert.equal(result.risk_callback.status, "RECORDED");
    const run = { binding: { task_id: result.task_id, proposal_sha256: result.proposal_sha256 } };
    await ctx.denied("/api/review/approval", approvalBody(ctx, run), ["SIMULATION_CAPABILITY_REQUIRED"], { owner: "approval" });
    await ctx.denied("/api/review/simulate", simulationBody(run), ["SIMULATION_CAPABILITY_REQUIRED", "EXECUTION_BLOCKED"]);
    const task = await ctx.ok(`/api/review/task/${encodeURIComponent(result.task_id)}`);
    assert.equal(task.execution.receipt, null); assert.equal(task.execution.simulation_allowed, false);
    const out = { scenario_id: ctx.name, result: "PASS", source_mode: MODEL_LABEL, real_model_calls: 0, model_test_double_calls: ctx.modelCalls(),
      trace: { task_id: result.task_id, run_id: result.run_id, audit_id: result.audit_id, proposal_sha256: result.proposal_sha256 },
      risk: result.risk_advice, risk_callback: result.risk_callback, approval: task.approval, execution: task.execution, audit_events: task.audit.events, http_steps: ctx.calls };
    ctx.assertNoSecrets(out); return out;
  });
  await check("unknown_callback_response", async ctx => {
    let callbackPosts = 0, committedCallbacks = 0;
    const reviewer = createConversationReviewer({ store: ctx.journal,
      config: { baseUrl: ctx.origin, apiKey: ctx.credentials.machine, hmacSecret: ctx.credentials.risk, reviewer: ctx.reviewer, allowLocalHttp: true, timeoutMs: 5000 },
      fetchImpl: async (url, options) => {
        const response = await fetch(url, options);
        if (new URL(url).pathname.endsWith("/risk-callback") && options.method === "POST") {
          callbackPosts++;
          const accepted = await response.json();
          assert.equal(response.status, 200); assert.equal(accepted.callback_status, "RECORDED");
          assert.equal(accepted.workflow.risk_decision.auth.verified, true);
          committedCallbacks++;
          throw new Error("SYNTHETIC_RESPONSE_LOST_AFTER_COMMIT");
        }
        return response;
      } });
    const input = { question: "虚构：只分析资金安排。", daily_finance_yuan: financeInput(), idempotency_key: "joint-unknown-response" };
    const result = await reviewer.review(input); assert.equal(result.risk_callback.status, "UNKNOWN"); assert.equal(result.execution_allowed, false);
    await assert.rejects(reviewer.review(input), { code: "REQUEST_RECONCILIATION_REQUIRED" });
    assert.equal(callbackPosts, 1); assert.equal(committedCallbacks, 1); assert.equal(ctx.modelCalls(), 1);
    const task = await ctx.ok(`/api/review/task/${encodeURIComponent(result.task_id)}`);
    assert.equal(task.execution.receipt, null); assert.equal(task.status, "PENDING_APPROVAL");
    assert.equal(task.risk_decision.decision, "APPROVE"); assert.equal(task.risk_decision.auth.verified, true);
    assert.equal(task.risk_decision.auth.actor, ctx.reviewer);
    assert.equal(task.audit.events.filter(row => row.event_type === "risk.approved").length, 1);
    assert.equal(task.audit.events.filter(row => row.event_type === "risk.callback.recorded").length, 1);
    const recorded = task.risk_callback.request;
    for (const [key, value] of Object.entries({ task_id: task.task_id, run_id: task.run_id, request_id: task.request_id,
      handoff_id: task.risk_handoff.handoff_id, audit_id: task.audit.audit_id, proposal_sha256: task.proposed_action.proposal_sha256 })) assert.equal(recorded[key], value);
    const out = { scenario_id: ctx.name, result: "PASS", source_mode: MODEL_LABEL, real_model_calls: 0,
      trace: { task_id: result.task_id, run_id: result.run_id, audit_id: result.audit_id, proposal_sha256: result.proposal_sha256 },
      risk_callback: result.risk_callback, approval: task.approval, execution: task.execution, callback_posts: callbackPosts,
      committed_callbacks: committedCallbacks, core_recorded_callback: task.risk_callback,
      model_evidence: { label: MODEL_LABEL, raw_text: task.model.model_response.raw_text },
      audit_events: task.audit.events, risk_audit_events: ctx.journal.events };
    ctx.assertNoSecrets(out); return out;
  });
  await check("result_storage_unknown", async ctx => {
    const run = await start(ctx); await callback(ctx, run); await approve(ctx, run);
    ctx.failures.persist = true;
    const unknown = await ctx.request("/api/review/simulate", simulationBody(run));
    assert.equal(unknown.status, 503); assert.equal(unknown.data.error.code, "REVIEW_SERVICE_UNAVAILABLE");
    const retry = await ctx.request("/api/review/simulate", simulationBody(run));
    assert.equal(retry.status, 503); assert.equal(retry.data.error.code, "REVIEW_SERVICE_UNAVAILABLE");
    const lookup = await ctx.request(`/api/review/task/${encodeURIComponent(run.binding.task_id)}`);
    assert.equal(lookup.status, 503);
    const markers = [...ctx.rows.values()].filter(row => row?.transition_version && row.state === "PENDING");
    assert.ok(markers.some(row => row.task_id === run.binding.task_id && row.operation === "/api/review/simulate"));
    assert.equal(ctx.rows.get(`funding:${run.plan.plan_id}`).allocations.length, 0);
    const out = { scenario_id: ctx.name, result: "PASS", source_mode: MODEL_LABEL, real_model_calls: 0, trace: run.binding,
      execution_result: "UNKNOWN", execution_allowed: false, model_test_double_calls: ctx.modelCalls(),
      response: unknown.data, retry_response: retry.data, pending_markers: markers, http_steps: ctx.calls, risk_audit_events: ctx.journal.events };
    ctx.assertNoSecrets(out); return out;
  });
  await check("approval_parameter_change", async ctx => {
    const run = await start(ctx); await callback(ctx, run); await approve(ctx, run);
    await ctx.denied("/api/review/simulate", { ...simulationBody(run), amount: 3000 }, ["UNEXPECTED_ACTION_FIELDS"]);
    await ctx.denied("/api/review/simulate", { ...simulationBody(run), proposal_sha256: "f".repeat(64) }, ["PROPOSAL_CHANGED"]);
    await ctx.denied("/api/review", { ...run.modelRequest, action_parameters: { ...run.modelRequest.action_parameters, amount: 3000 } }, ["IDEMPOTENCY_CONFLICT"]);
    const out = await evidence(ctx, run); assert.equal(out.execution.receipt, null); assert.equal(out.funding_plan.allocated_minor, 0); return out;
  });
  await check("cross_task_funds_rechecked", async ctx => {
    const first = await start(ctx, { amount: "4000" }); await callback(ctx, first); await approve(ctx, first);
    await ctx.ok("/api/review/simulate", simulationBody(first));
    // The second program assessment deliberately has a stale declaration of zero holds.
    // The execution guard must still read the shared Core demo plan and stop it.
    const second = await start(ctx, { amount: "3000", plan: first.plan });
    assert.equal(second.assessment.risk_result.decision, "ALLOW");
    await callback(ctx, second); await approve(ctx, second);
    await ctx.denied("/api/review/simulate", simulationBody(second), ["FUNDING_CONFLICT"]);
    const out = await evidence(ctx, second); assert.equal(out.execution.receipt, null); assert.equal(out.funding_plan.allocations.length, 1);
    assert.equal(out.funding_plan.allocated_minor, 400000);
    return { ...out, previous_task: first.binding, stale_hold_declaration_detected_at: "CORE_FUNDING_GUARD" };
  });
  return { schema_version: "risk-joint-acceptance.v1", generated_at: new Date().toISOString(), mode: "LOCAL_HTTP_COMPONENT_INTEGRATION",
    source_manifest: snapshot.manifest, model_evidence: MODEL_LABEL, approval_evidence: APPROVAL_LABEL,
    core_storage: "IN_MEMORY_TEST_ADAPTER_NOT_CLOUDFLARE_SQLITE", paper_scope: "CORE_INTERNAL_SIMULATED_RECEIPT_ONLY",
    original_conversation_capability: "REVIEW_ONLY_UNCHANGED", joint_acceptance: false, production_connected: false, real_model_calls: 0,
    passed: cases.length, failed: failures.length, cases, failures,
    live_acceptance_requirements: ["VERIFY_PRODUCTION_WORKER_SHARED_CORE_RISK_TASK", "VERIFY_REAL_MODEL_RISK_CHAIN_WITH_AUTHORIZED_BUDGET", "VERIFY_REAL_USER_APPROVAL_AND_PAPER_ACCOUNT_GATEWAY"] };
}

module.exports = { runLocalAcceptance, MODEL_LABEL, APPROVAL_LABEL };
