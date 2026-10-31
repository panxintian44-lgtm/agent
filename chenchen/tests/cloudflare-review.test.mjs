import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { createHash } from "node:crypto";
import worker, { ReviewService } from "../deployment/worker.js";
import { reviewDocs } from "../deployment/review-docs.js";
import workflowModule from "../integrations/review-workflow.js";

const proposal = {
  summary: "虚构账单要求改付个人账户。", risk_level: "high",
  proposed_action: "FLAG_FOR_RISK", action_reason: "需核验账户变更依据。",
  missing_information: ["变更授权"], evidence: ["收款人变为个人"]
};
function setup() {
  const records = new Map();
  const storage = {
    async get(key) { return structuredClone(records.get(key)); },
    async put(entries) { for (const [key, value] of Object.entries(entries)) records.set(key, structuredClone(value)); }
  };
  const env = {
    MODEL_PROVIDER: "workers_ai", MODEL_DISABLE_RULE_FALLBACK: "true", CORS_ORIGINS: "*", RATE_LIMIT_PER_MINUTE: "0",
    AI: { run: async () => ({ response: proposal, usage: { prompt_tokens: 60, completion_tokens: 90 } }) }
  };
  const create = () => new ReviewService({ storage }, env);
  let service = create();
  env.REVIEW_SERVICE = { idFromName: name => name, get: () => service };
  return { env, storage, restart() { service = create(); } };
}
function req(path, body) {
  return new Request("https://test.example" + path, body === undefined ? {} : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
  });
}

test("health does not advertise an incomplete DeepSeek configuration as configured", async () => {
  for (const config of [{ MODEL_API_KEY: "test" }, { MODEL_NAME: "configured-model" },
    { MODEL_API_KEY: "test", MODEL_NAME: "configured-model", MODEL_API_STYLE: "responses" }]) {
    const health = await worker.fetch(req("/health"), { MODEL_PROVIDER: "deepseek", ...config }).then(r => r.json());
    assert.equal(health.model.configured, false);
  }
});

test("capabilities report demo, real integration and execution boundaries without calling services", async () => {
  const app = setup();
  const response = await worker.fetch(req("/api/review/capabilities"), app.env);
  assert.equal(response.status, 200);
  const capabilities = await response.json();
  assert.equal(capabilities.capability_version, "core-agent-capabilities.v1");
  assert.equal(capabilities.model.configured, true);
  assert.equal(capabilities.model.inference_probe, "NOT_RUN");
  assert.deepEqual(capabilities.model.response_id_sources, ["body.id", "body.response_id", "header.x-request-id", "header.x-correlation-id"]);
  assert.equal(capabilities.risk.dispatch_ready, false);
  assert.equal(capabilities.approval.signature_configured, false);
  assert.equal(capabilities.approval.trusted_identity_ready, false);
  assert.equal(capabilities.approval.trusted_identity_evidence, "APPROVAL_SERVICE_REQUIRED");
  assert.equal(capabilities.approval.demo_actor_labels_allowed, true);
  assert.equal(capabilities.execution.allowed, false);
  assert.equal(capabilities.execution.gateway_connected, false);
  assert.equal(capabilities.acceptance.joint_acceptance, false);
});

test("approval service signature does not masquerade as end-user identity or approval", async () => {
  const app = setup();
  app.env.APPROVAL_SERVICE_HMAC_SECRET = "synthetic-approval-service-secret";
  app.env.REQUIRE_TRUSTED_ACTORS = "true";
  const capabilities = await worker.fetch(req("/api/review/capabilities"), app.env).then(r => r.json());
  assert.equal(capabilities.approval.signature_configured, true);
  assert.equal(capabilities.approval.trusted_identity_ready, false);
  assert.equal(capabilities.approval.trusted_identity_evidence, "APPROVAL_SERVICE_REQUIRED");
  assert.equal(capabilities.approval.demo_actor_labels_allowed, false);
});

test("public review survives cold starts and keeps workflow mutations in the audit", async () => {
  const app = setup();
  const created = await worker.fetch(req("/api/review", { kind: "bill", text: "虚构账单改付个人" }), app.env);
  assert.equal(created.status, 200);
  const record = await created.json();
  assert.equal(record.model.model_response.call_succeeded, true);
  app.restart();
  const reloaded = await worker.fetch(req("/api/review/" + record.run_id), app.env);
  assert.deepEqual(await reloaded.json(), record);
  const blocked = await worker.fetch(req("/api/review/simulate", {
    task_id: record.task_id, proposal_sha256: record.proposed_action.proposal_sha256
  }), app.env);
  assert.equal(blocked.status, 409);
  app.restart();
  const audited = await worker.fetch(req("/api/review/task/" + record.task_id), app.env).then(r => r.json());
  assert.equal(audited.execution.execution_allowed, false);
  assert.ok(audited.audit.events.length > record.audit.events.length);
});

test("persisted pre-scenario requests remain idempotent across a worker upgrade", async () => {
  const app = setup();
  const input = { text: "虚构升级前账单", idempotency_key: "legacy-durable-retry", action_parameters: { amount: 25 } };
  const created = await worker.fetch(req("/api/review", input), app.env).then(r => r.json());
  delete created.reviewed_input.scenario;
  delete created.reviewed_input.output_formats;
  created.request_fingerprint = await workflowModule.fingerprint(created.reviewed_input);
  await app.storage.put({ ["run:" + created.run_id]: created });
  app.restart();
  app.env.AI.run = async () => { throw new Error("replay must not invoke the model again"); };
  const replay = await worker.fetch(req("/api/review", input), app.env);
  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), created);
  for (const changed of [{ text: "不同用途" }, { scenario: "DOUBLE11_COMPARE" }, { output_formats: ["xlsx"] }, { action_parameters: { amount: 50 } }]) {
    const conflict = await worker.fetch(req("/api/review", { ...input, ...changed }), app.env);
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json()).error.code, "IDEMPOTENCY_CONFLICT");
  }
});

test("durable workflow refuses Risk mutation after simulation", async () => {
  const app = setup();
  const created = await worker.fetch(req("/api/review", { capability: "SIMULATION_ONLY", kind: "bill", text: "虚构账单" }), app.env).then(r => r.json());
  const base = { task_id: created.task_id, proposal_sha256: created.proposed_action.proposal_sha256 };
  await worker.fetch(req("/api/review/risk-decision", { ...base, decision: "APPROVE", reviewer: "risk", reason: "通过" }), app.env);
  await worker.fetch(req("/api/review/approval", { ...base, decision: "APPROVE", approver: "approver", reason: "通过" }), app.env);
  const simulated = await worker.fetch(req("/api/review/simulate", base), app.env).then(r => r.json());
  assert.equal(simulated.status, "SIMULATED");
  const repeated = await worker.fetch(req("/api/review/risk-decision", { ...base, decision: "APPROVE", reviewer: "risk", reason: "重复" }), app.env);
  assert.equal(repeated.status, 409);
  const repeatedError = await repeated.json();
  assert.equal(repeatedError.error.code, "WORKFLOW_TERMINAL");
  assert.equal(repeatedError.error_contract_version, "core-agent-error.v1");
  assert.equal(repeatedError.source_contract_version, "model-review.v1");
  assert.equal(repeatedError.trace.task_id, created.task_id);
  assert.equal(repeatedError.trace.session_id, null);
  const queried = await worker.fetch(req("/api/review/task/" + created.task_id), app.env).then(r => r.json());
  assert.equal(queried.status, "SIMULATED");
  assert.equal(queried.execution.status, "SIMULATED");
});

test("expired approval blocks the HTTP execution route and remains expired after reload", async () => {
  const app = setup();
  const created = await worker.fetch(req("/api/review", { capability: "SIMULATION_ONLY", text: "Synthetic expiring approval" }), app.env).then(r => r.json());
  const input = { task_id: created.task_id, proposal_sha256: created.proposed_action.proposal_sha256 };
  const risk = await worker.fetch(req("/api/review/risk-decision", { ...input, decision: "APPROVE", reviewer: "synthetic-risk", reason: "Local PAPER test" }), app.env);
  assert.equal(risk.status, 200);
  const approval = await worker.fetch(req("/api/review/approval", { ...input, decision: "APPROVE", approver: "synthetic-user", reason: "Local PAPER test" }), app.env);
  assert.equal(approval.status, 200);
  const approved = await approval.json();
  approved.approval.expires_at = new Date(Date.now() - 1000).toISOString();
  await app.storage.put({ ["run:" + created.run_id]: approved });
  app.restart();
  app.env.AI.run = async () => { throw new Error("Execution must not call the model"); };
  const blocked = await worker.fetch(req("/api/review/simulate", input), app.env);
  assert.equal(blocked.status, 409);
  const body = await blocked.json();
  assert.equal(body.error.code, "APPROVAL_EXPIRED");
  assert.equal(body.trace.task_id, created.task_id);
  app.restart();
  const saved = await worker.fetch(req("/api/review/task/" + created.task_id), app.env).then(r => r.json());
  assert.equal(saved.status, "EXPIRED");
  assert.equal(saved.execution.receipt, null);
  assert.equal(saved.execution.simulation_allowed, false);
  assert.equal(saved.execution.execution_allowed, false);
  assert.equal(saved.audit.events.filter(e => e.event_type === "approval.expired").length, 1);
});

test("failed real inference returns an error and a persistent blocked record", async () => {
  const app = setup();
  let calls = 0;
  app.env.AI.run = async () => { calls++; throw new Error("unavailable"); };
  const response = await worker.fetch(req("/api/review", { text: "虚构新闻", allow_rule_fallback: true }), app.env);
  assert.equal(response.status, 502);
  const failed = await response.json();
  assert.equal(failed.workflow.status, "MODEL_FAILED");
  app.restart();
  const record = await worker.fetch(req("/api/review/" + failed.trace.run_id), app.env).then(r => r.json());
  assert.equal(record.status, "MODEL_FAILED");
  assert.equal(calls, 2);
  assert.equal(record.model.response.attempt_count, 2);
  assert.equal(record.model.response.retry_count, 1);
  assert.equal(record.audit.events.filter(e => e.event_type === "model.retry_scheduled").length, 1);
  const handoff = await worker.fetch(req("/api/review/" + record.run_id + "/risk-handoff"), app.env).then(r => r.json());
  assert.equal(handoff.model.attempt_count, 2);
  assert.equal(handoff.model.retry_count, 1);
  assert.equal(handoff.model.call_succeeded, false);
  const approval = await worker.fetch(req("/api/review/risk-decision", {
    task_id: record.task_id, decision: "APPROVE", reviewer: "demo"
  }), app.env);
  assert.equal(approval.status, 409);
  assert.equal((await approval.json()).error.code, "RISK_BLOCKED");
});

test("retried Workers AI inference retains one task and durable Risk evidence without authorizing execution", async () => {
  const app = setup();
  let calls = 0;
  app.env.AI.run = async () => {
    calls++;
    if (calls === 1) throw new Error("temporary");
    return { id: "synthetic-retry-response", response: proposal };
  };
  const response = await worker.fetch(req("/api/review", { task_id: "retry-task", text: "synthetic" }), app.env);
  assert.equal(response.status, 200);
  const record = await response.json();
  assert.equal(calls, 2);
  assert.equal(record.status, "PENDING_RISK");
  assert.equal(record.model.model_response.retry_count, 1);
  const retry = record.audit.events.find(e => e.event_type === "model.retry_scheduled");
  assert.equal(retry.task_id, record.task_id);
  assert.equal(retry.payload.run_id, record.run_id);
  assert.equal(retry.payload.request_id, record.request_id);
  app.restart();
  const restored = await worker.fetch(req("/api/review/task/" + record.task_id), app.env).then(r => r.json());
  assert.deepEqual(restored, record);
  const handoff = await worker.fetch(req("/api/review/task/" + record.task_id + "/risk-handoff"), app.env).then(r => r.json());
  assert.equal(handoff.model.attempt_count, 2);
  assert.equal(handoff.model.retry_count, 1);
  const blocked = await worker.fetch(req("/api/review/simulate", { task_id: record.task_id, proposal_sha256: record.proposed_action.proposal_sha256 }), app.env);
  assert.equal(blocked.status, 409);
  assert.equal(restored.execution.execution_allowed, false);
});

test("public endpoint validates input, caps requests, and accepts frontend preflight", async () => {
  const { env } = setup();
  for (const input of [null, [], {}, { kind: "invalid", text: "x" }]) {
    assert.equal((await worker.fetch(req("/api/review", input), env)).status, 422);
  }
  assert.equal((await worker.fetch(req("/api/review", { text: "x".repeat(100001) }), env)).status, 413);
  const malformed = new Request("https://test.example/api/review", { method: "POST", body: "{" });
  assert.equal((await worker.fetch(malformed, env)).status, 400);
  const options = new Request("https://test.example/api/review", { method: "OPTIONS", headers: { Origin: "https://team.example" } });
  const preflight = await worker.fetch(options, env);
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("Access-Control-Allow-Origin"), "https://team.example");
  env.MODEL_REQUESTS_PER_MINUTE = "1";
  assert.equal((await worker.fetch(req("/api/review", { text: "虚构账单" }), env)).status, 200);
  assert.equal((await worker.fetch(req("/api/review", { text: "虚构账单" }), env)).status, 429);
});

test("explicit task ids cannot create a second workflow record", async () => {
  const { env } = setup();
  const body = { task_id: "review-task-fixed-001", kind: "bill", text: "虚构账单" };
  assert.equal((await worker.fetch(req("/api/review", body), env)).status, 200);
  const duplicate = await worker.fetch(req("/api/review", body), env);
  assert.equal(duplicate.status, 409);
  assert.equal((await duplicate.json()).error.code, "TASK_ALREADY_EXISTS");
});

test("decision retry conflicts and validation failures persist without changing approved evidence", async () => {
  const app = setup();
  const created = await worker.fetch(req("/api/review", { capability: "SIMULATION_ONLY", text: "Synthetic approval identity check" }), app.env).then(r => r.json());
  const binding = { task_id: created.task_id, proposal_sha256: created.proposed_action.proposal_sha256 };
  for (const [path, actor, conflictCode] of [["risk-decision", "reviewer", "RISK_DECISION_IMMUTABLE"], ["approval", "approver", "APPROVAL_IMMUTABLE"]]) {
    const body = { ...binding, decision: "APPROVE", [actor]: "synthetic-owner", reason: "Same evidence" };
    const first = await worker.fetch(req("/api/review/" + path, body), app.env).then(r => r.json());
    app.restart();
    const repeat = await worker.fetch(req("/api/review/" + path, body), app.env);
    assert.equal(repeat.status, 200);
    assert.deepEqual(await repeat.json(), first);
    for (const patch of [{ [actor]: "different-owner" }, { reason: "Different evidence" }]) {
      const conflict = await worker.fetch(req("/api/review/" + path, { ...body, ...patch }), app.env);
      assert.equal(conflict.status, 409);
      const payload = await conflict.json();
      assert.equal(payload.error.code, conflictCode);
      assert.equal(payload.trace.task_id, created.task_id);
      assert.equal(payload.trace.audit_id, created.audit.audit_id);
    }
    const invalid = await worker.fetch(req("/api/review/" + path, { ...body, reason: " " }), app.env);
    assert.equal(invalid.status, 422);
  }
  app.restart();
  const final = await worker.fetch(req("/api/review/task/" + created.task_id), app.env).then(r => r.json());
  assert.equal(final.risk_decision.reviewer, "synthetic-owner");
  assert.equal(final.approval.approver, "synthetic-owner");
  assert.equal(final.audit.events.filter(e => e.event_type === "workflow.operation_blocked").length, 6);
  assert.equal(final.execution.execution_allowed, false);
});

test("legacy question endpoint returns an adapter response without bypassing Risk", async () => {
  const { env } = setup();
  const response = await worker.fetch(req("/api/review/legacy", {
    question: "我想追加投资，但下个月要交房租，是否冲突？",
    run_id: "legacy-cloudflare-001"
  }), env);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.contract_version, "legacy-review.v0");
  assert.equal(payload.source_contract, "review-workflow.v1");
  assert.equal(payload.execution_state, "awaiting_risk");
  assert.equal(payload.gate.execution_allowed, false);
  assert.equal(payload.auto_executed, false);
  const query = await worker.fetch(req("/api/review/" + payload.run_id), env);
  assert.equal((await query.json()).task_id, payload.task_id);
});

test("test page is reachable even when opening the POST URL in a browser", async () => {
  const { env } = setup();
  const response = await worker.fetch(req("/api/review"), env);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("Content-Type"), /text\/html/);
  assert.match(await response.text(), /调用真实模型/);
  new vm.Script(reviewDocs.match(/<script>([\s\S]*?)<\/script>/)[1]);
});

test("handoff callback is persistent, idempotent, audit-bound and guarded against concurrent conflicts", async () => {
  const app = setup();
  const record = await worker.fetch(req("/api/review", { text: "Synthetic investment and rent conflict" }), app.env).then(r => r.json());
  const handoff = await worker.fetch(req("/api/review/" + record.run_id + "/risk-handoff"), app.env).then(r => r.json());
  assert.equal(handoff.audit_id, record.audit.audit_id);
  assert.equal(handoff.handoff_version, "risk-handoff.v1");
  assert.equal(createHash("sha256").update(JSON.stringify(handoff.reviewed_input)).digest("hex"), handoff.evidence.input_sha256);
  assert.equal(handoff.input_authority, "UNVERIFIED_CALLER_INPUT");
  const callback = {
    callback_version: "risk-callback.v1", handoff_id: handoff.handoff_id,
    task_id: handoff.task_id, request_id: handoff.request_id, run_id: handoff.run_id,
    audit_id: handoff.audit_id, proposal_sha256: handoff.proposal.proposal_sha256,
    decision: "REJECT", reviewer: "synthetic-risk-owner", reason: "Test rejection"
  };
  const mismatch = await worker.fetch(req("/api/review/risk-callback", { ...callback, run_id: "wrong" }), app.env);
  assert.equal(mismatch.status, 409);
  assert.equal((await mismatch.json()).error.code, "RISK_HANDOFF_MISMATCH");
  app.restart();
  const audited = await worker.fetch(req("/api/review/task/" + record.task_id), app.env).then(r => r.json());
  assert.ok(audited.audit.events.some(e => e.event_type === "risk.callback.blocked"));
  assert.equal(audited.risk_decision, null);
  const responses = await Promise.all([
    worker.fetch(req("/api/review/risk-callback", callback), app.env),
    worker.fetch(req("/api/review/risk-callback", callback), app.env),
    worker.fetch(req("/api/review/risk-callback", { ...callback, decision: "APPROVE" }), app.env)
  ]);
  assert.deepEqual(responses.map(r => r.status), [200, 200, 409]);
  const recorded = await responses[0].json(), duplicate = await responses[1].json();
  assert.equal(recorded.callback_status, "RECORDED");
  assert.equal(duplicate.callback_status, "DUPLICATE");
  assert.deepEqual(recorded.workflow, duplicate.workflow);
  assert.equal((await responses[2].json()).error.code, "RISK_CALLBACK_CONFLICT");
  app.restart();
  const repeated = await worker.fetch(req("/api/review/risk-callback", callback), app.env).then(r => r.json());
  assert.equal(repeated.callback_status, "DUPLICATE");
  const final = await worker.fetch(req("/api/review/task/" + record.task_id + "/risk-handoff"), app.env).then(r => r.json());
  assert.equal(final.workflow_status, "REJECTED");
  assert.equal(final.execution_allowed, false);
  const blocked = await worker.fetch(req("/api/review/simulate", { task_id: record.task_id, proposal_sha256: callback.proposal_sha256 }), app.env);
  assert.equal(blocked.status, 409);
});

test("handoff reads and callbacks use the same configured API authentication", async () => {
  const app = setup();
  app.env.CORE_AGENT_API_KEY = "test-only-key";
  for (const request of [req("/api/review/task/example/risk-handoff"), req("/api/review/risk-callback", {})]) {
    assert.equal((await worker.fetch(request, app.env)).status, 401);
    request.headers.set("X-Core-Agent-Key", "test-only-key");
    assert.notEqual((await worker.fetch(request, app.env)).status, 401);
  }
});

test("Risk dispatch fails closed and persists the Owner configuration failure", async () => {
  const app = setup();
  const created = await worker.fetch(req("/api/review", { text: "Synthetic Risk dispatch" }), app.env).then(r => r.json());
  const response = await worker.fetch(req("/api/review/risk-dispatch", {
    task_id: created.task_id,
    proposal_sha256: created.proposed_action.proposal_sha256
  }), app.env);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, "RISK_OWNER_NOT_CONFIGURED");
  app.restart();
  const record = await worker.fetch(req("/api/review/task/" + created.task_id), app.env).then(r => r.json());
  assert.equal(record.risk_dispatch.status, "FAILED");
  assert.ok(record.audit.events.some(event => event.event_type === "risk.handoff.dispatch_failed"));
  assert.equal(record.execution.execution_allowed, false);
});

const fundingDefinition = { confirmed: true, synthetic: true, currency: "CNY", cash_minor: 1000000,
  protected_purposes: [{ purpose_id: "rent", label: "房租", amount_minor: 400000 }] };
async function fundingTask(app, plan, amount = 4000) {
  const response = await worker.fetch(req("/api/review", { capability: "SIMULATION_ONLY", text: "Synthetic investment conflicts with rent", action_parameters: {
    amount, currency: "CNY", synthetic: true, funding_plan_id: plan.plan_id, funding_plan_revision: plan.revision
  } }), app.env);
  assert.equal(response.status, 200);
  const created = await response.json();
  const base = { task_id: created.task_id, proposal_sha256: created.proposed_action.proposal_sha256 };
  const callback = await worker.fetch(req("/api/review/risk-callback", { ...base,
    callback_version: "risk-callback.v1", handoff_id: created.risk_handoff.handoff_id,
    request_id: created.request_id, run_id: created.run_id, audit_id: created.audit.audit_id,
    decision: "APPROVE", reviewer: "demo-risk", reason: "Synthetic guard test"
  }), app.env);
  assert.equal(callback.status, 200);
  const approved = await worker.fetch(req("/api/review/approval", { ...base, decision: "APPROVE", approver: "demo-user", reason: "Synthetic guard test" }), app.env);
  assert.equal(approved.status, 200);
  return { created, base };
}

test("public funding ledger serializes concurrent tasks and survives restart with matching receipts", async () => {
  const app = setup();
  const plan = await worker.fetch(req("/api/funding-demo/plan", fundingDefinition), app.env).then(r => r.json());
  const a = await fundingTask(app, plan), b = await fundingTask(app, plan);
  app.restart();
  const responses = await Promise.all([a, b].map(({ base }) => worker.fetch(req("/api/review/simulate", base), app.env)));
  assert.deepEqual(responses.map(r => r.status), [200, 409]);
  const result = await responses[0].json();
  assert.equal((await responses[1].json()).error.code, "FUNDING_CONFLICT");
  app.restart();
  const ledger = await worker.fetch(req("/api/funding-demo/plan/" + plan.plan_id), app.env).then(r => r.json());
  assert.equal(ledger.available_minor, 200000);
  assert.equal(ledger.allocations.length, 1);
  assert.equal(ledger.allocations[0].execution_id, result.execution.execution_id);
  const repeat = await worker.fetch(req("/api/review/simulate", a.base), app.env).then(r => r.json());
  assert.deepEqual(repeat.execution.receipt, result.execution.receipt);
});

test("plan revision after approval is persisted and blocks stale execution", async () => {
  const app = setup();
  const plan = await worker.fetch(req("/api/funding-demo/plan", fundingDefinition), app.env).then(r => r.json());
  const task = await fundingTask(app, plan);
  const revised = await worker.fetch(req("/api/funding-demo/plan/revise", { ...fundingDefinition, plan_id: plan.plan_id, expected_revision: 1, cash_minor: 1100000 }), app.env);
  assert.equal(revised.status, 200);
  app.restart();
  const simulated = await worker.fetch(req("/api/review/simulate", task.base), app.env);
  assert.equal(simulated.status, 409);
  assert.equal((await simulated.json()).error.code, "FUNDING_PLAN_CHANGED");
  const record = await worker.fetch(req("/api/review/task/" + task.created.task_id), app.env).then(r => r.json());
  assert.equal(record.execution.simulation_allowed, false);
  assert.equal(record.status, "FUNDING_BLOCKED");
  assert.ok(record.audit.events.some(e => e.event_type === "funding.blocked"));
});

test("public cancellation preserves the audit and blocks all later Risk changes", async () => {
  const app = setup();
  const plan = await worker.fetch(req("/api/funding-demo/plan", fundingDefinition), app.env).then(r => r.json());
  const task = await fundingTask(app, plan);
  const cancelled = await worker.fetch(req("/api/review/cancel", {
    ...task.base, canceler: "demo-user", reason: "停止这项演示任务"
  }), app.env);
  assert.equal(cancelled.status, 200);
  const cancelledRecord = await cancelled.json();
  assert.equal(cancelledRecord.status, "CANCELLED");
  assert.equal(cancelledRecord.execution.execution_allowed, false);
  assert.equal(cancelledRecord.risk_handoff.decision, "CANCELLED");
  const risk = await worker.fetch(req("/api/review/risk-decision", {
    ...task.base, decision: "APPROVE", reviewer: "late", reason: "late"
  }), app.env);
  assert.equal(risk.status, 409);
  assert.equal((await risk.json()).error.code, "WORKFLOW_TERMINAL");
  app.restart();
  const queried = await worker.fetch(req("/api/review/task/" + task.created.task_id), app.env).then(r => r.json());
  assert.equal(queried.status, "CANCELLED");
  assert.ok(queried.audit.events.some(e => e.event_type === "task.cancelled"));
});

test("failed atomic persistence cannot leave orphan allocations or a successful receipt", async () => {
  const app = setup();
  const plan = await worker.fetch(req("/api/funding-demo/plan", fundingDefinition), app.env).then(r => r.json());
  const task = await fundingTask(app, plan);
  const originalPut = app.storage.put;
  app.storage.put = async entries => {
    if (Object.values(entries).some(v => v?.status === "SIMULATED")) {
      assert.ok(entries["funding:" + plan.plan_id]);
      throw new Error("Injected atomic storage failure");
    }
    return originalPut(entries);
  };
  const failed = await worker.fetch(req("/api/review/simulate", task.base), app.env);
  assert.equal(failed.status, 503);
  assert.equal((await failed.json()).error.retryable, false);
  app.restart();
  // Inspect storage directly to retain the atomicity check. An unresolved
  // transition must not expose this older snapshot as usable API state.
  const ledger = await app.storage.get("funding:" + plan.plan_id);
  assert.equal(ledger.allocations.length, 0);
  const record = await app.storage.get("run:" + task.created.run_id);
  assert.equal(record.status, "READY_FOR_SIMULATION");
  assert.equal(record.execution.receipt, null);
  for (const endpoint of ["/api/funding-demo/plan/" + plan.plan_id, "/api/review/task/" + task.created.task_id]) {
    const response = await worker.fetch(req(endpoint), app.env);
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.retryable, false);
  }
  app.storage.put = originalPut;
  assert.equal((await worker.fetch(req("/api/review/simulate", task.base), app.env)).status, 503);
});
