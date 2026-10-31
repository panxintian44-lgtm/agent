import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { runCase as previousCase } from "../dual-benchmark-v3/checks.mjs";
import worker, { ReviewService } from "../../deployment/worker.js";
import workflow from "../../integrations/review-workflow.js";
import funding from "../../integrations/funding-plan.js";
import bridge from "../../integrations/owner-bridge.js";
import evidence from "../../integrations/review-evidence.js";

const bind = record => ({ task_id: record.task_id, proposal_sha256: record.proposed_action.proposal_sha256 });
const definition = x => ({ synthetic: true, confirmed: true, currency: "CNY", cash_minor: x.available_minor + x.rent_minor,
  protected_purposes: [{ purpose_id: "synthetic-rent", label: "合成房租", amount_minor: x.rent_minor }] });
const parameters = (x, plan) => ({ synthetic: true, currency: "CNY", amount: x.requested_minor / 100,
  funding_plan_id: plan.plan_id, funding_plan_revision: plan.revision });
const risk = record => ({ ...bind(record), decision: "APPROVE", reviewer: "synthetic-risk", reason: "固定测试判定" });
const approval = record => ({ ...bind(record), decision: "APPROVE", approver: "synthetic-user", reason: "仅模拟执行" });
const callback = (record, decision) => ({ ...bind(record), callback_version: "risk-callback.v1", request_id: record.request_id,
  run_id: record.run_id, handoff_id: record.risk_handoff.handoff_id, audit_id: record.audit.audit_id,
  decision, reviewer: "synthetic-risk", reason: "固定测试回调" });
const finalWrite = entries => Object.keys(entries).some(k => k.startsWith("run:"));

function audit(record) {
  assert.equal(record.execution.execution_allowed, false);
  for (const event of record.audit.events) {
    assert.equal(event.task_id, record.task_id);
    for (const key of ["task_id", "request_id", "run_id", "session_id"]) assert.equal(event.payload.trace[key], record[key]);
    assert.equal(event.payload.trace.audit_id, record.audit.audit_id);
  }
  if (record.execution.receipt) {
    assert.equal(record.execution.receipt.side_effects, false);
    assert.equal(record.execution.receipt.task_id, record.task_id);
  }
  assert.equal(evidence.buildReviewEvidence(record).manifest.consistency_status, "CONSISTENT_WITH_LIMITS");
}
function unavailable(response, taskId) {
  assert.equal(response.status, 503);
  assert.equal(response.body.error.code, "REVIEW_SERVICE_UNAVAILABLE");
  assert.equal(response.body.error.retryable, false);
  assert.equal(response.body.workflow, null);
  if (taskId) assert.equal(response.body.trace.task_id, taskId);
}
function storageApp() {
  const rows = new Map(), requests = [], modelCalls = [];
  let rejectWrites = () => false;
  const storage = { get: async key => structuredClone(rows.get(key)), put: async entries => {
    if (rejectWrites(entries)) throw new Error("SYNTHETIC_STORAGE_FAILURE");
    for (const [key, value] of Object.entries(entries)) rows.set(key, structuredClone(value));
  } };
  const env = { MODEL_PROVIDER: "workers_ai", MODEL_MAX_ATTEMPTS: "1", MODEL_REQUESTS_PER_MINUTE: "100",
    MODEL_DISABLE_RULE_FALLBACK: "true", MODEL_FALLBACK_TO_RULES: "false", RATE_LIMIT_PER_MINUTE: "0", REQUIRE_TRUSTED_ACTORS: "true",
    RISK_SERVICE_HMAC_SECRET: randomBytes(32).toString("hex"), APPROVAL_SERVICE_HMAC_SECRET: randomBytes(32).toString("hex"),
    RISK_REVIEWER_ID: "synthetic-risk",
    AI: { run: async (...args) => {
      const response = { id: "synthetic-provider-" + (modelCalls.length + 1), response: {
        summary: "合成存储故障测试", risk_level: "unknown", proposed_action: "HOLD_FOR_REVIEW",
        action_reason: "先通过 Risk 和审批", evidence: [], missing_information: [] } };
      modelCalls.push({ input: structuredClone(args), response }); return response;
    } } };
  let service = new ReviewService({ storage }, env);
  env.REVIEW_SERVICE = { idFromName: id => id, get: () => service };
  return { rows, storage, env, requests, modelCalls, fail: predicate => { rejectWrites = predicate; },
    restart: () => { service = new ReviewService({ storage }, env); } };
}
async function call(app, endpoint, body, signed = true) {
  const headers = { "Content-Type": "application/json" };
  if (signed && ["/api/review/risk-decision", "/api/review/risk-callback"].includes(endpoint)) {
    headers["X-Risk-Signature"] = await bridge.signatureFor(body, app.env.RISK_SERVICE_HMAC_SECRET);
  }
  if (signed && endpoint === "/api/review/approval") headers["X-Approval-Signature"] = await bridge.signatureFor(body, app.env.APPROVAL_SERVICE_HMAC_SECRET);
  const response = await worker.fetch(new Request("https://synthetic.test" + endpoint,
    body === undefined ? {} : { method: "POST", headers, body: JSON.stringify(body) }), app.env);
  const result = { status: response.status, body: await response.json() };
  // Neither ephemeral signing keys nor signature headers enter evidence.
  app.requests.push({ endpoint, body, signed, response: result });
  return result;
}
async function approve(app, record) {
  assert.equal((await call(app, "/api/review/risk-decision", risk(record))).status, 200);
  assert.equal((await call(app, "/api/review/approval", approval(record))).status, 200);
}

async function storageCase(c) {
  const x = c.input, app = storageApp();
  const createdPlan = await call(app, "/api/funding-demo/plan", definition(x));
  assert.equal(createdPlan.status, 200); const plan = createdPlan.body;
  const request = { text: x.text, data_mode: "SYNTHETIC_REPLAY", memory_consent: false, idempotency_key: c.case_id,
    action_parameters: parameters(x, plan) };
  let result, record, expectedCalls = 1;
  const restore = () => { app.fail(() => false); app.restart(); };
  if (["reservation-fail", "model-save-fail", "model-ack-loss", "reservation-ack-loss"].includes(x.mode)) {
    const put = app.storage.put;
    if (x.mode === "reservation-fail") app.fail(() => true);
    if (x.mode === "model-save-fail") app.fail(finalWrite);
    if (x.mode.endsWith("ack-loss")) app.storage.put = async entries => {
      await put(entries);
      if (x.mode === "reservation-ack-loss" || finalWrite(entries)) throw new Error("SYNTHETIC_ACK_LOSS");
    };
    result = await call(app, "/api/review", request); unavailable(result);
    assert.equal(app.modelCalls.length, x.mode.startsWith("reservation") ? 0 : 1);
    app.storage.put = put; restore();
    for (let i = 0; i < x.retries; i++) {
      const retry = await call(app, "/api/review", request);
      if (["reservation-fail", "model-ack-loss"].includes(x.mode)) {
        assert.equal(retry.status, 200); record = retry.body;
      } else unavailable(retry, result.body.trace.task_id);
    }
    if (x.mode === "reservation-ack-loss") expectedCalls = 0;
    if (x.mode === "model-save-fail") {
      const changed = await call(app, "/api/review", { ...request, action_parameters: { ...request.action_parameters, amount: request.action_parameters.amount + 1 } });
      assert.equal(changed.status, 409); assert.equal(changed.body.error.code, "IDEMPOTENCY_CONFLICT");
      unavailable(await call(app, "/api/review/task/" + result.body.trace.task_id));
    }
  } else {
    const created = await call(app, "/api/review", request); assert.equal(created.status, 200); record = created.body;
    if (x.mode === "invalid-signature") {
      const before = structuredClone(app.rows.get("run:" + record.run_id));
      for (let i = 0; i < x.retries; i++) assert.equal((await call(app, "/api/review/risk-decision", risk(record), false)).status, 401);
      assert.deepEqual(app.rows.get("run:" + record.run_id), before);
      assert.ok(![...app.rows.values()].some(v => v?.transition_version && v.state === "PENDING"));
      const denied = await call(app, "/api/review/simulate", bind(record));
      assert.equal(denied.status, 409); assert.equal(denied.body.error.code, "EXECUTION_BLOCKED");
      app.restart(); record = (await call(app, "/api/review/task/" + record.task_id)).body;
    } else if (x.mode === "approval-save-fail") {
      assert.equal((await call(app, "/api/review/risk-decision", risk(record))).status, 200);
      app.fail(finalWrite); unavailable(await call(app, "/api/review/approval", approval(record)), record.task_id); restore();
      for (let i = 0; i < x.retries; i++) unavailable(await call(app, "/api/review/approval", { ...approval(record), approver: "synthetic-other-" + i }), record.task_id);
      unavailable(await call(app, "/api/review/simulate", bind(record)), record.task_id); record = null;
    } else {
      await approve(app, record);
      if (x.mode === "cancel-save-fail") {
        app.fail(finalWrite);
        unavailable(await call(app, "/api/review/cancel", { ...bind(record), canceler: "synthetic-user", reason: "保留房租" }), record.task_id);
        restore();
        for (const endpoint of ["/api/review/task/" + record.task_id, "/api/review/" + record.run_id,
          "/api/review/task/" + record.task_id + "/risk-handoff"]) unavailable(await call(app, endpoint), record.task_id);
        for (let i = 0; i < x.retries; i++) unavailable(await call(app, "/api/review/simulate", bind(record)), record.task_id);
        unavailable(await call(app, "/api/review", request), record.task_id); record = null;
      } else if (x.mode === "plan-save-fail") {
        app.fail(entries => Object.keys(entries).some(k => k.startsWith("funding:")));
        unavailable(await call(app, "/api/funding-demo/plan/revise", { ...definition(x), cash_minor: x.available_minor + x.rent_minor + 1,
          plan_id: plan.plan_id, expected_revision: plan.revision })); restore();
        for (let i = 0; i < x.retries; i++) unavailable(await call(app, "/api/review/simulate", bind(record)));
        unavailable(await call(app, "/api/funding-demo/plan/" + plan.plan_id)); record = null;
      } else if (x.mode === "simulation-save-fail") {
        const second = await call(app, "/api/review", { ...request, idempotency_key: c.case_id + "-second" });
        assert.equal(second.status, 200); await approve(app, second.body); expectedCalls = 2;
        app.fail(finalWrite); unavailable(await call(app, "/api/review/simulate", bind(record)), record.task_id); restore();
        for (let i = 0; i < x.retries; i++) unavailable(await call(app, "/api/review/simulate", bind(second.body)));
        unavailable(await call(app, "/api/funding-demo/plan/" + plan.plan_id)); record = null;
      } else if (x.mode === "simulation-ack-loss") {
        const put = app.storage.put; let lost = false;
        app.storage.put = async entries => { await put(entries); if (finalWrite(entries) && !lost) { lost = true; throw new Error("SYNTHETIC_ACK_LOSS"); } };
        unavailable(await call(app, "/api/review/simulate", bind(record)), record.task_id);
        const receipt = structuredClone(app.rows.get("run:" + record.run_id).execution.receipt);
        app.storage.put = put; restore();
        for (let i = 0; i < x.retries; i++) {
          const replay = await call(app, "/api/review/simulate", bind(record)); assert.equal(replay.status, 200);
          assert.deepEqual(replay.body.execution.receipt, receipt); record = replay.body;
        }
        assert.equal(record.audit.events.filter(e => e.event_type === "execution.simulated").length, 1);
      } else throw new Error("Unsupported storage mode");
    }
  }
  assert.equal(app.modelCalls.length, expectedCalls);
  assert.equal(record?.status || "BLOCKED_UNCERTAIN", c.expected.status);
  const savedPlan = app.rows.get("funding:" + plan.plan_id);
  assert.equal(savedPlan.allocations.length, c.expected.allocations);
  for (const [key, value] of app.rows) if (key.startsWith("run:")) audit(value);
  return { status: record?.status || "BLOCKED_UNCERTAIN", synthetic_provider_calls: app.modelCalls.length,
    allocation_count: savedPlan.allocations.length, recovery_mode: "SAME_PROCESS_SERVICE_RECONSTRUCTION",
    evidence: { requests: app.requests, model_calls: app.modelCalls, stored_rows: [...app.rows] } };
}

function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function model(input) {
  return { run_id: "synthetic-run-" + input.task_id, status: "PROPOSED", source: "model", input: { input_sha256: "a".repeat(64) },
    model_response: { call_succeeded: true, provider_response_id: "synthetic-" + input.task_id, model: "synthetic",
      proposal: { summary: "合成并发测试", risk_level: "unknown", proposed_action: "HOLD_FOR_REVIEW", action_reason: "等待 Risk", missing_information: [], evidence: [] } },
    audit: { audit_id: "audit-" + input.task_id, events: [] } };
}
async function concurrentCase(c) {
  const x = c.input, plans = new funding.FundingPlanStore(), plan = plans.create(definition(x));
  const modelGate = deferred(), dispatchGate = deferred(), modelCalls = [], operations = []; let sends = 0;
  const slow = ["same-key", "changed-key", "model-failure"].includes(x.mode);
  const store = new workflow.ReviewWorkflowStore({ fundingPlans: plans, modelRunner: async input => {
    const log = { input: structuredClone(input) }; modelCalls.push(log);
    if (slow) await modelGate.promise;
    if (x.mode === "model-failure") { log.error = "MODEL_PROVIDER_ERROR"; throw Object.assign(new Error("SYNTHETIC_MODEL_FAILURE"), { code: log.error }); }
    log.response = model(input); return log.response;
  } });
  const request = { text: x.text, idempotency_key: c.case_id, data_mode: "SYNTHETIC_REPLAY", memory_consent: false, action_parameters: parameters(x, plan) };
  let record;
  if (slow) {
    const first = store.start(request);
    if (x.mode === "changed-key") {
      const rejected = Array.from({ length: x.retries }, (_, i) => assert.rejects(store.start({ ...request,
        action_parameters: { ...request.action_parameters, amount: request.action_parameters.amount + i + 1 } }), { code: "IDEMPOTENCY_CONFLICT" }));
      modelGate.resolve(); record = await first; await Promise.all(rejected); operations.push({ changed_requests_rejected: x.retries });
    } else {
      const pending = [first, ...Array.from({ length: x.retries - 1 }, () => store.start(request))];
      const settled = Promise.allSettled(pending); modelGate.resolve(); const results = await settled;
      record = await store.start(request);
      if (x.mode === "same-key") for (const result of results) {
        assert.equal(result.status, "fulfilled"); assert.equal(result.value.run_id, record.run_id); assert.equal(result.value.task_id, record.task_id);
      }
      if (x.mode === "model-failure") {
        assert.ok(results.every(r => r.status === "rejected" || r.value.status === "MODEL_FAILED"));
        assert.equal(record.execution.status, "BLOCKED");
      }
      operations.push({ settled: results.map(r => ({ status: r.status, workflow_status: r.value?.status, error_code: r.reason?.code })) });
    }
    assert.equal(store.records.size, 1);
  } else {
    record = await store.start(request); const binding = bind(record);
    if (x.mode.startsWith("dispatch-")) {
      const sender = envelope => { sends++; operations.push({ dispatch: envelope }); return dispatchGate.promise; };
      const pending = store.dispatchRiskHandoff(binding, sender);
      if (x.mode === "dispatch-cancel") {
        await store.cancel({ ...binding, canceler: "synthetic-user", reason: "保留生活费" }); dispatchGate.resolve({ upstream_status: 202 }); await pending;
        await assert.rejects(store.simulate(binding), { code: "EXECUTION_BLOCKED" });
      } else if (x.mode === "dispatch-reject") {
        await store.receiveRiskCallback(callback(record, "REJECT"));
        const rejected = assert.rejects(pending, e => e.code === "OWNER_SERVICE_UNAVAILABLE" && e.workflowRecord.status === "REJECTED");
        dispatchGate.reject(Object.assign(new Error("SYNTHETIC_OWNER_FAILURE"), { code: "OWNER_SERVICE_UNAVAILABLE" })); await rejected;
        await assert.rejects(store.simulate(binding), { code: "EXECUTION_BLOCKED" });
      } else if (x.mode === "dispatch-receipt") {
        await store.receiveRiskCallback(callback(record, "APPROVE")); await store.decideApproval(approval(record));
        const receipts = await Promise.all(Array.from({ length: x.retries }, () => store.simulate(binding)));
        for (const r of receipts) assert.deepEqual(r.execution.receipt, receipts[0].execution.receipt);
        dispatchGate.resolve({ upstream_status: 202 }); const late = await pending;
        assert.deepEqual(late.execution.receipt, receipts[0].execution.receipt);
        assert.equal(late.audit.events.filter(e => e.event_type === "execution.simulated").length, 1);
      } else {
        const retries = Array.from({ length: x.retries - 1 }, () => store.dispatchRiskHandoff(binding, sender));
        await assert.rejects(store.dispatchRiskHandoff({ ...binding, proposal_sha256: "changed" }, sender), { code: "PROPOSAL_CHANGED" });
        dispatchGate.resolve({ upstream_status: 202 }); const results = await Promise.all([pending, ...retries]);
        assert.equal(new Set(results.map(r => r.risk_dispatch.dispatch_id)).size, 1);
        assert.equal(results[0].risk_dispatch.attempts, 1);
        assert.equal(results[0].audit.events.filter(e => e.event_type === "risk.handoff.dispatched").length, 1);
      }
      assert.equal(sends, 1);
    } else if (x.mode === "callback-duplicate") {
      const cb = callback(record, "APPROVE"), results = await Promise.all(Array.from({ length: x.retries }, () => store.receiveRiskCallback(cb)));
      assert.equal(results.filter(r => r.callback_status === "RECORDED").length, 1);
      assert.equal(results.filter(r => r.callback_status === "DUPLICATE").length, x.retries - 1);
      await assert.rejects(store.receiveRiskCallback({ ...cb, decision: "REJECT" }), { code: "RISK_CALLBACK_CONFLICT" });
      await assert.rejects(store.simulate(binding), { code: "EXECUTION_BLOCKED" });
    } else {
      await store.decideRisk(risk(record)); await store.decideApproval(approval(record));
      if (x.mode === "approval-duplicate") {
        await Promise.all(Array.from({ length: x.retries }, () => store.decideApproval(approval(record))));
        await assert.rejects(store.decideApproval({ ...approval(record), approver: "synthetic-other" }), { code: "APPROVAL_IMMUTABLE" });
        assert.equal(store.getByTaskId(record.task_id).audit.events.filter(e => e.event_type === "approval.approved").length, 1);
      } else if (x.mode === "execution-changed") {
        for (let i = 0; i < x.retries; i++) await assert.rejects(store.simulate({ ...binding, amount: x.requested_minor / 100 + i + 1 }), { code: "UNEXPECTED_ACTION_FIELDS" });
        await assert.rejects(store.simulate({ ...binding, proposal_sha256: "changed" }), { code: "PROPOSAL_CHANGED" });
      } else throw new Error("Unsupported concurrent mode");
    }
    record = store.getByTaskId(record.task_id);
  }
  assert.equal(modelCalls.length, 1); assert.equal(record.status, c.expected.status); audit(record);
  const summary = plans.summary(plan.plan_id);
  assert.equal(summary.allocations.length, c.expected.allocations);
  assert.equal(summary.allocated_minor, c.expected.allocations ? x.requested_minor : 0);
  if (!c.expected.allocations) assert.equal(record.execution.receipt, null);
  return { status: record.status, synthetic_provider_calls: modelCalls.length, synthetic_risk_sends: sends,
    allocation_count: summary.allocations.length, retries: x.retries,
    evidence: { model_calls: modelCalls, operations, record, funding_plan: summary } };
}

export function runCase(c) {
  if (c.group === "storage_fault") return storageCase(c);
  if (c.group === "concurrent_workflow") return concurrentCase(c);
  return previousCase(c);
}
