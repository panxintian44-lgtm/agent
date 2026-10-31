import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { runCase as recoveryCase } from "../recovery-benchmark-v4/checks.mjs";
import workflow from "../../integrations/review-workflow.js";
import funding from "../../integrations/funding-plan.js";
import bridge from "../../integrations/owner-bridge.js";
import evidence from "../../integrations/review-evidence.js";
import worker, { ReviewService } from "../../deployment/worker.js";

const binding = r => ({ task_id: r.task_id, proposal_sha256: r.proposed_action.proposal_sha256 });
const risk = r => ({ ...binding(r), decision: "APPROVE", reviewer: "synthetic-risk", reason: "本地替身判定" });
const approval = r => ({ ...binding(r), decision: "APPROVE", approver: "synthetic-user", reason: "仅模拟执行" });
const callback = r => ({ ...binding(r), callback_version: "risk-callback.v1", handoff_id: r.risk_handoff.handoff_id,
  request_id: r.request_id, run_id: r.run_id, audit_id: r.audit.audit_id, decision: "APPROVE", reviewer: "synthetic-risk", reason: "本地替身回调" });
const params = (plan, minor) => ({ amount: minor / 100, synthetic: true, currency: "CNY", funding_plan_id: plan.plan_id, funding_plan_revision: plan.revision });
const definition = x => ({ synthetic: true, confirmed: true, currency: "CNY", cash_minor: x.available_minor + x.rent_minor + x.tuition_minor,
  protected_purposes: [{ purpose_id: "rent", label: "合成房租", amount_minor: x.rent_minor }, { purpose_id: "tuition", label: "合成学费", amount_minor: x.tuition_minor }] });
function checkAudit(record) {
  assert.equal(record.execution.execution_allowed, false);
  for (const event of record.audit.events) {
    assert.equal(event.task_id, record.task_id);
    for (const field of ["task_id", "request_id", "run_id", "session_id"]) assert.equal(event.payload.trace[field], record[field]);
    assert.equal(event.payload.trace.audit_id, record.audit.audit_id);
  }
  assert.equal(evidence.buildReviewEvidence(record).manifest.consistency_status, "CONSISTENT_WITH_LIMITS");
  if (record.execution.receipt) {
    assert.equal(record.execution.receipt.side_effects, false);
    assert.equal(record.execution.receipt.task_id, record.task_id);
  }
}
function model(input) {
  return { run_id: "synthetic-run-" + randomUUID(), status: "PROPOSED", source: "model", input: { input_sha256: "a".repeat(64) },
    model_response: { provider_response_id: "synthetic-provider", proposal: { proposed_action: "HOLD_FOR_REVIEW", risk_level: "unknown", action_reason: "先风控再审批" } },
    audit: { audit_id: "synthetic-audit-" + randomUUID(), events: [] } };
}

async function fundingBatch(c) {
  const x = c.input, plans = new funding.FundingPlanStore(), plan = plans.create(definition(x)), modelCalls = [];
  const secondPlan = x.mode === "cross-plan-isolation" ? plans.create(definition(x)) : null;
  const store = new workflow.ReviewWorkflowStore({ fundingPlans: plans, modelRunner: async input => {
    const response = model(input); modelCalls.push({ input: structuredClone(input), response }); return response;
  } });
  const created = [], observations = [];
  for (let i = 0; i < x.tasks; i++) {
    const chosen = secondPlan && i % 2 ? secondPlan : plan;
    const r = await store.start({ text: x.text + " 子任务" + i, data_mode: "SYNTHETIC_REPLAY", memory_consent: false,
      idempotency_key: c.case_id + "-" + i, action_parameters: params(chosen, x.unit_minor) });
    created.push(r);
    if (x.mode === "risk-reject-one" && i === 0) await store.decideRisk({ ...risk(r), decision: "REJECT" });
    else { await store.decideRisk(risk(r)); await store.decideApproval(approval(r)); }
  }
  if (x.mode === "rent-increase") plans.revise({ ...definition(x), plan_id: plan.plan_id, expected_revision: 1,
    protected_purposes: [{ purpose_id: "rent", label: "合成房租", amount_minor: x.rent_minor + 1 }, definition(x).protected_purposes[1]] });
  if (x.mode === "same-plan-reorder") {
    const again = plans.revise({ ...definition(x), plan_id: plan.plan_id, expected_revision: 1, protected_purposes: definition(x).protected_purposes.toReversed() });
    assert.equal(again.revision, 1);
  }
  if (x.mode === "cancel-one") await store.cancel({ ...binding(created[0]), canceler: "synthetic-user", reason: "保留生活费" });
  if (x.mode === "approval-expired") for (const r of created) {
    const expired = store.getByTaskId(r.task_id); expired.approval.expires_at = "2000-01-01T00:00:00Z"; store.save(expired);
  }
  const tasks = created.flatMap(r => Array.from({ length: x.retries }, () => r));
  const outcomes = await Promise.allSettled(tasks.map(r => store.simulate(binding(r))));
  const blockedCode = x.mode === "rent-increase" ? "FUNDING_PLAN_CHANGED" : x.mode === "approval-expired" ? "APPROVAL_EXPIRED" :
    ["cancel-one", "risk-reject-one"].includes(x.mode) ? "EXECUTION_BLOCKED" : "FUNDING_CONFLICT";
  const permittedRepeatCodes = new Set([blockedCode, "EXECUTION_BLOCKED"]);
  for (let i = 0; i < outcomes.length; i++) {
    const result = outcomes[i];
    if (result.status === "rejected") assert.ok(permittedRepeatCodes.has(result.reason.code), result.reason.code);
    observations.push({ task_id: tasks[i].task_id, result: result.status, error_code: result.reason?.code,
      execution_id: result.value?.execution.receipt?.execution_id });
  }
  let records = created.map(r => store.getByTaskId(r.task_id));
  assert.equal(records.filter(r => r.status === "SIMULATED").length, c.expected.simulated_tasks);
  for (const record of records) {
    const results = outcomes.filter((_, i) => tasks[i].task_id === record.task_id);
    if (record.status === "SIMULATED") {
      assert.ok(results.every(r => r.status === "fulfilled"));
      assert.equal(new Set(results.map(r => r.value.execution.receipt.execution_id)).size, 1);
      assert.equal(record.audit.events.filter(e => e.event_type === "execution.simulated").length, 1);
    } else assert.equal(record.execution.receipt, null);
    checkAudit(record);
  }
  if (x.mode === "post-execution-revise") {
    const oldReceipts = records.map(r => r.execution.receipt);
    const changed = plans.revise({ ...definition(x), plan_id: plan.plan_id, expected_revision: 1,
      protected_purposes: [{ purpose_id: "rent", label: "合成房租", amount_minor: x.rent_minor + 1 }, definition(x).protected_purposes[1]] });
    assert.equal(changed.deficit_minor, 1);
    for (let i = 0; i < records.length; i++) assert.deepEqual((await store.simulate(binding(records[i]))).execution.receipt, oldReceipts[i]);
    const extra = await store.start({ text: x.text + " 新任务", data_mode: "SYNTHETIC_REPLAY", memory_consent: false, action_parameters: params(changed, 1) });
    await store.decideRisk(risk(extra)); await store.decideApproval(approval(extra));
    await assert.rejects(store.simulate(binding(extra)), { code: "FUNDING_CONFLICT" });
    records = [...created, extra].map(r => store.getByTaskId(r.task_id)); records.forEach(checkAudit);
  }
  const summaries = [plan, ...(secondPlan ? [secondPlan] : [])].map(p => plans.summary(p.plan_id));
  assert.equal(summaries.reduce((n, p) => n + p.allocated_minor, 0), c.expected.allocated_minor);
  assert.equal(summaries.reduce((n, p) => n + p.allocations.length, 0), c.expected.simulated_tasks);
  for (const p of summaries) {
    assert.equal(new Set(p.allocations.map(a => a.task_id)).size, p.allocations.length);
    for (const a of p.allocations) {
      const r = records.find(r => r.task_id === a.task_id); assert.ok(r);
      assert.equal(r.execution.receipt.execution_id, a.execution_id); assert.equal(a.amount_minor, x.unit_minor);
    }
    if (x.mode !== "post-execution-revise") assert.equal(p.deficit_minor, 0);
  }
  assert.equal(modelCalls.length, x.tasks + (x.mode === "post-execution-revise" ? 1 : 0));
  return { simulated_tasks: c.expected.simulated_tasks, allocated_minor: c.expected.allocated_minor,
    rejected_attempts: outcomes.filter(r => r.status === "rejected").length, synthetic_model_calls: modelCalls.length,
    evidence: { model_calls: modelCalls, observations, records, funding_plans: summaries } };
}

function setup() {
  const rows = new Map(), requests = [], modelCalls = [];
  const storage = { get: async key => structuredClone(rows.get(key)), put: async entries => {
    for (const [key, value] of Object.entries(entries)) rows.set(key, structuredClone(value));
  } };
  const env = { MODEL_PROVIDER: "workers_ai", MODEL_MAX_ATTEMPTS: "1", MODEL_DISABLE_RULE_FALLBACK: "true", MODEL_REQUESTS_PER_MINUTE: "100",
    RATE_LIMIT_PER_MINUTE: "0", REQUIRE_TRUSTED_ACTORS: "true", CORE_AGENT_API_KEY: randomBytes(32).toString("hex"),
    RISK_SERVICE_HMAC_SECRET: randomBytes(32).toString("hex"), APPROVAL_SERVICE_HMAC_SECRET: randomBytes(32).toString("hex"),
    RISK_REVIEWER_ID: "synthetic-risk",
    AI: { run: async (...args) => {
      const response = { id: "synthetic-provider-" + modelCalls.length, response: { summary: "合成签名边界测试", proposed_action: "HOLD_FOR_REVIEW",
        risk_level: "unknown", action_reason: "等待风控与审批", evidence: [], missing_information: [] } };
      modelCalls.push({ input: structuredClone(args), response }); return response;
    } } };
  let service = new ReviewService({ storage }, env);
  env.REVIEW_SERVICE = { idFromName: name => name, get: () => service };
  return { rows, requests, modelCalls, env, restart: () => { service = new ReviewService({ storage }, env); } };
}
async function call(app, endpoint, body, options = {}) {
  const headers = { "Content-Type": "application/json" };
  if (!options.omitApiKey) headers["X-Core-Agent-Key"] = app.env.CORE_AGENT_API_KEY;
  const owner = endpoint === "/api/review/approval" ? "approval" : ["/api/review/risk-decision", "/api/review/risk-callback"].includes(endpoint) ? "risk" : null;
  if (owner) headers[owner === "risk" ? "X-Risk-Signature" : "X-Approval-Signature"] = await bridge.signatureFor(options.signedBody || body,
    options.secret || app.env[owner === "risk" ? "RISK_SERVICE_HMAC_SECRET" : "APPROVAL_SERVICE_HMAC_SECRET"]);
  const response = await worker.fetch(new Request("https://synthetic.test" + endpoint,
    body === undefined ? { headers } : { method: "POST", headers, body: JSON.stringify(body) }), app.env);
  const result = { status: response.status, body: await response.json() };
  app.requests.push({ endpoint, body, signature_mode: options.secret ? "OVERRIDE" : options.signedBody ? "BODY_TAMPER_TEST" : "NORMAL",
    api_key_omitted: Boolean(options.omitApiKey), response_status: result.status, error_code: result.body.error?.code,
    task_id: result.body.task_id || result.body.workflow?.task_id, workflow_status: result.body.status || result.body.workflow?.status });
  return result;
}
async function ownerBoundary(c) {
  const x = c.input, app = setup();
  const planReply = await call(app, "/api/funding-demo/plan", { synthetic: true, confirmed: true, currency: "CNY",
    cash_minor: x.unit_minor * 3 + x.rent_minor, protected_purposes: [{ purpose_id: "rent", label: "合成房租", amount_minor: x.rent_minor }] });
  assert.equal(planReply.status, 200); const plan = planReply.body;
  const original = { text: x.text, data_mode: "SYNTHETIC_REPLAY", idempotency_key: c.case_id, memory_consent: false,
    context: { user_note: "预留房租", labels: { rent: true, tuition: false }, ordered_items: ["rent", "tuition"] }, action_parameters: params(plan, x.unit_minor) };
  const firstReply = await call(app, "/api/review", original); assert.equal(firstReply.status, 200); const a = firstReply.body;
  const secondReply = await call(app, "/api/review", { ...original, text: x.text + " 第二个任务", idempotency_key: c.case_id + "-b" });
  assert.equal(secondReply.status, 200); const b = secondReply.body;
  const originalA = structuredClone(a), originalB = structuredClone(b);
  const approvalMode = x.mode.startsWith("approval-");
  if (approvalMode) assert.equal((await call(app, "/api/review/risk-decision", risk(a))).status, 200);
  let endpoint = "/api/review/risk-decision", body = risk(a), options = {};
  switch (x.mode) {
    case "risk-wrong-key": options.secret = app.env.APPROVAL_SERVICE_HMAC_SECRET; break;
    case "approval-wrong-key": endpoint = "/api/review/approval"; body = approval(a); options.secret = app.env.RISK_SERVICE_HMAC_SECRET; break;
    case "risk-tampered": options.signedBody = risk(a); body = { ...body, decision: "REJECT" }; break;
    case "approval-tampered": endpoint = "/api/review/approval"; options.signedBody = approval(a); body = { ...approval(a), decision: "REJECT" }; break;
    case "callback-cross-task": endpoint = "/api/review/risk-callback"; body = { ...callback(a), [x.trace_field]: callback(b)[x.trace_field] }; break;
    case "approval-cross-task": endpoint = "/api/review/approval"; body = { ...approval(a), task_id: b.task_id }; break;
    case "callback-extra-field": endpoint = "/api/review/risk-callback"; body = { ...callback(a), amount: x.unit_minor / 100 }; break;
    case "key-rotation": options.secret = app.env.RISK_SERVICE_HMAC_SECRET; app.env.RISK_SERVICE_HMAC_SECRET = randomBytes(32).toString("hex"); app.restart(); break;
    case "api-missing": options.omitApiKey = true; break;
    case "canonical-retry": {
      endpoint = "/api/review";
      body = { ...original, context: { ordered_items: ["rent", "tuition"], labels: { tuition: false, rent: true }, user_note: "预留房租" },
        action_parameters: Object.fromEntries(Object.entries(original.action_parameters).reverse()) };
      break;
    }
    default: throw new Error("Unknown owner mode");
  }
  for (let i = 0; i < x.retries; i++) {
    if (i === 1) app.restart();
    const response = await call(app, endpoint, body, options);
    assert.equal(response.status, c.expected.status);
    if (c.expected.code) assert.equal(response.body.error.code, c.expected.code);
    else { assert.equal(response.body.run_id, a.run_id); assert.equal(response.body.task_id, a.task_id); }
  }
  if (x.mode === "canonical-retry") {
    for (const context of [{ ...body.context, ordered_items: ["tuition", "rent"] }, { ...body.context, labels: { rent: "true", tuition: false } }]) {
      const changed = await call(app, endpoint, { ...body, context });
      assert.equal(changed.status, 409); assert.equal(changed.body.error.code, "IDEMPOTENCY_CONFLICT");
    }
  }
  if (x.mode === "api-missing") {
    assert.equal((await call(app, "/api/review/task/" + a.task_id, undefined, options)).status, 401);
    assert.equal((await call(app, "/api/review/simulate", binding(a), options)).status, 401);
  }
  const beforeA = (await call(app, "/api/review/task/" + a.task_id)).body;
  const beforeB = (await call(app, "/api/review/task/" + b.task_id)).body;
  assert.equal(beforeA.status, approvalMode ? "PENDING_APPROVAL" : "PENDING_RISK");
  assert.equal(beforeB.status, "PENDING_RISK");
  assert.deepEqual(beforeA.proposed_action, originalA.proposed_action); assert.deepEqual(beforeB.proposed_action, originalB.proposed_action);
  assert.equal(beforeA.execution.receipt, null); assert.equal(beforeB.execution.receipt, null);
  assert.equal(app.modelCalls.length, 2);
  if (!approvalMode) assert.equal((await call(app, "/api/review/risk-decision", risk(a))).status, 200);
  assert.equal((await call(app, "/api/review/approval", approval(a))).status, 200);
  const executed = await call(app, "/api/review/simulate", binding(a)); assert.equal(executed.status, 200);
  app.restart();
  const replay = await call(app, "/api/review/simulate", binding(a)); assert.equal(replay.status, 200);
  assert.deepEqual(replay.body.execution.receipt, executed.body.execution.receipt);
  const untouched = await call(app, "/api/review/simulate", binding(b));
  assert.equal(untouched.status, 409); assert.equal(untouched.body.error.code, "EXECUTION_BLOCKED");
  const finalB = (await call(app, "/api/review/task/" + b.task_id)).body, finalA = replay.body;
  const finalPlan = (await call(app, "/api/funding-demo/plan/" + plan.plan_id)).body;
  assert.equal(finalPlan.allocations.length, 1); assert.equal(finalPlan.allocated_minor, x.unit_minor);
  assert.equal(finalPlan.allocations[0].task_id, a.task_id); assert.equal(app.modelCalls.length, 2);
  [finalA, finalB].forEach(checkAudit);
  assert.equal(finalA.risk_decision.auth.verified, true); assert.equal(finalA.approval.auth.verified, true);
  return { status: finalA.status, allocation_count: finalPlan.allocations.length, invalid_status: c.expected.status,
    invalid_code: c.expected.code, synthetic_model_calls: app.modelCalls.length,
    evidence: { model_calls: app.modelCalls, requests: app.requests, records: [finalA, finalB], funding_plan: finalPlan } };
}
export function runCase(c) {
  if (c.group === "funding_batch") return fundingBatch(c);
  if (c.group === "signed_owner_boundary") return ownerBoundary(c);
  return recoveryCase(c);
}
