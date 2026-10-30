import assert from "node:assert/strict";
import test from "node:test";
import worker, { ReviewService } from "../deployment/worker.js";

function setup() {
  const rows = new Map(); let fail = () => false, calls = 0;
  const storage = { get: async key => structuredClone(rows.get(key)), put: async entries => {
    if (fail(entries)) throw new Error("SYNTHETIC_WRITE_FAILURE");
    for (const [key, value] of Object.entries(entries)) rows.set(key, structuredClone(value));
  } };
  const env = { MODEL_PROVIDER: "workers_ai", MODEL_MAX_ATTEMPTS: "1", MODEL_REQUESTS_PER_MINUTE: "100", RATE_LIMIT_PER_MINUTE: "0",
    AI: { run: async () => { calls++; return { id: "synthetic-transition-" + calls, response: {
      summary: "Synthetic recovery", risk_level: "unknown", proposed_action: "HOLD_FOR_REVIEW", action_reason: "Risk required", evidence: [], missing_information: [] } }; } } };
  let service = new ReviewService({ storage }, env);
  env.REVIEW_SERVICE = { idFromName: x => x, get: () => service };
  return { rows, env, storage, calls: () => calls, fail: fn => { fail = fn; }, restart: () => { service = new ReviewService({ storage }, env); } };
}
async function call(app, endpoint, body) {
  const response = await worker.fetch(new Request("https://synthetic.test" + endpoint, body === undefined ? {} : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
  }), app.env);
  return { status: response.status, body: await response.json() };
}
const binding = r => ({ task_id: r.task_id, proposal_sha256: r.proposed_action.proposal_sha256 });
async function start(app, extra = {}) { return (await call(app, "/api/review", { capability: "SIMULATION_ONLY", text: "Synthetic transition", ...extra })).body; }
async function approve(app, r) {
  assert.equal((await call(app, "/api/review/risk-decision", { ...binding(r), decision: "APPROVE", reviewer: "synthetic-risk", reason: "Test" })).status, 200);
  assert.equal((await call(app, "/api/review/approval", { ...binding(r), decision: "APPROVE", approver: "synthetic-user", reason: "Test" })).status, 200);
}
const finalWrite = entries => Object.keys(entries).some(k => k.startsWith("run:"));
function assertPending(response, taskId) {
  assert.equal(response.status, 503);
  assert.equal(response.body.error.code, "REVIEW_SERVICE_UNAVAILABLE");
  assert.equal(response.body.error.retryable, false);
  if (taskId) assert.equal(response.body.trace.task_id, taskId);
  assert.equal(response.body.workflow, null);
}

test("failed cancellation save blocks old approval, every read alias and idempotent replay after restart", async () => {
  const app = setup(), input = { idempotency_key: "transition-cancel" }, record = await start(app, input);
  await approve(app, record); app.fail(finalWrite);
  const response = await call(app, "/api/review/cancel", { ...binding(record), canceler: "synthetic-user", reason: "Keep rent" });
  assertPending(response, record.task_id);
  app.fail(() => false); app.restart();
  for (const endpoint of ["/api/review/task/" + record.task_id, "/api/review/" + record.run_id,
    "/api/review/task/" + record.task_id + "/risk-handoff", "/api/review/" + record.run_id + "/risk-handoff"]) {
    assertPending(await call(app, endpoint), record.task_id);
  }
  assertPending(await call(app, "/api/review/simulate", binding(record)), record.task_id);
  assertPending(await call(app, "/api/review", { capability: "SIMULATION_ONLY", text: "Synthetic transition", ...input }), record.task_id);
  assert.equal(app.calls(), 1);
});

test("lost Risk callback save prevents replacement by another decision", async () => {
  const app = setup(), record = await start(app); app.fail(finalWrite);
  const callback = { callback_version: "risk-callback.v1", ...binding(record), request_id: record.request_id, run_id: record.run_id,
    audit_id: record.audit.audit_id, handoff_id: record.risk_handoff.handoff_id, decision: "REJECT", reviewer: "synthetic-risk", reason: "Rent conflict" };
  assertPending(await call(app, "/api/review/risk-callback", callback), record.task_id);
  app.fail(() => false); app.restart();
  assertPending(await call(app, "/api/review/risk-callback", { ...callback, decision: "APPROVE" }), record.task_id);
  assertPending(await call(app, "/api/review/approval", { ...binding(record), decision: "APPROVE", approver: "synthetic-user", reason: "Test" }), record.task_id);
});

test("a lost approval save preserves trace and cannot silently accept a second approver", async () => {
  const app = setup(), record = await start(app);
  await call(app, "/api/review/risk-decision", { ...binding(record), decision: "APPROVE", reviewer: "synthetic-risk", reason: "Test" });
  app.fail(finalWrite);
  assertPending(await call(app, "/api/review/approval", { ...binding(record), decision: "APPROVE", approver: "synthetic-first", reason: "Test" }), record.task_id);
  app.fail(() => false); app.restart();
  assertPending(await call(app, "/api/review/approval", { ...binding(record), decision: "APPROVE", approver: "synthetic-second", reason: "Test" }), record.task_id);
});

const definition = { synthetic: true, confirmed: true, currency: "CNY", cash_minor: 1000000,
  protected_purposes: [{ purpose_id: "rent", label: "Synthetic rent", amount_minor: 400000 }] };
const parameters = plan => ({ synthetic: true, currency: "CNY", amount: 4000, funding_plan_id: plan.plan_id, funding_plan_revision: plan.revision });

test("uncertain simulation blocks other tasks and revisions sharing its funding plan", async () => {
  const app = setup(), plan = (await call(app, "/api/funding-demo/plan", definition)).body;
  const a = await start(app, { action_parameters: parameters(plan) }), b = await start(app, { action_parameters: parameters(plan) });
  await approve(app, a); await approve(app, b);
  app.fail(finalWrite);
  assertPending(await call(app, "/api/review/simulate", binding(a)), a.task_id);
  app.fail(() => false); app.restart();
  assertPending(await call(app, "/api/review/simulate", binding(b)));
  assertPending(await call(app, "/api/funding-demo/plan/" + plan.plan_id));
  assertPending(await call(app, "/api/funding-demo/plan/revise", { ...definition, plan_id: plan.plan_id, expected_revision: plan.revision }));
  assert.equal(app.rows.get("funding:" + plan.plan_id).allocations.length, 0);
  const unrelated = await start(app); await approve(app, unrelated);
  assert.equal((await call(app, "/api/review/simulate", binding(unrelated))).status, 200);
});

test("uncertain funding revision blocks the old plan and existing approved task", async () => {
  const app = setup(), plan = (await call(app, "/api/funding-demo/plan", definition)).body;
  const record = await start(app, { action_parameters: parameters(plan) }); await approve(app, record);
  app.fail(entries => Object.keys(entries).some(k => k.startsWith("funding:")));
  assertPending(await call(app, "/api/funding-demo/plan/revise", { ...definition, cash_minor: 1200000, plan_id: plan.plan_id, expected_revision: plan.revision }));
  app.fail(() => false); app.restart();
  assertPending(await call(app, "/api/review/simulate", binding(record)));
});

test("a completed simulation whose acknowledgement is lost replays one durable receipt and allocation", async () => {
  const app = setup(), plan = (await call(app, "/api/funding-demo/plan", definition)).body;
  const record = await start(app, { action_parameters: parameters(plan) }); await approve(app, record);
  const put = app.storage.put; let lost = false;
  app.storage.put = async entries => {
    await put(entries);
    if (finalWrite(entries) && !lost) { lost = true; throw new Error("SYNTHETIC_LOST_ACK"); }
  };
  assertPending(await call(app, "/api/review/simulate", binding(record)), record.task_id);
  const saved = structuredClone(app.rows.get("run:" + record.run_id)); app.restart();
  const replay = await call(app, "/api/review/simulate", binding(record));
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.body.execution.receipt, saved.execution.receipt);
  assert.equal(app.rows.get("funding:" + plan.plan_id).allocations.length, 1);
  assert.equal(replay.body.audit.events.filter(e => e.event_type === "execution.simulated").length, 1);
});

test("failed admission cannot mutate workflow and rejected signatures cannot create a pending transition", async () => {
  const app = setup(), record = await start(app), original = structuredClone(app.rows.get("run:" + record.run_id));
  app.env.REQUIRE_TRUSTED_ACTORS = "true";
  app.env.RISK_SERVICE_HMAC_SECRET = "synthetic-test-secret";
  assert.equal((await call(app, "/api/review/risk-decision", { ...binding(record), decision: "REJECT", reviewer: "synthetic-risk", reason: "Test" })).status, 401);
  assert.deepEqual(app.rows.get("run:" + record.run_id), original);
  assert.ok(![...app.rows.values()].some(v => v?.transition_version && v.state === "PENDING"));
  app.fail(() => true);
  assertPending(await call(app, "/api/review/cancel", { ...binding(record), canceler: "synthetic-user", reason: "Test" }), record.task_id);
  assert.deepEqual(app.rows.get("run:" + record.run_id), original);
});

test("business rejection remains auditable and does not leave an unresolved transition", async () => {
  const app = setup(), record = await start(app);
  const denied = await call(app, "/api/review/simulate", binding(record));
  assert.equal(denied.status, 409); assert.equal(denied.body.error.code, "EXECUTION_BLOCKED");
  app.restart(); const read = await call(app, "/api/review/task/" + record.task_id);
  assert.equal(read.status, 200); assert.equal(read.body.status, "PENDING_RISK");
  assert.ok(read.body.audit.events.some(e => e.event_type === "workflow.operation_blocked"));
  assert.ok(![...app.rows.values()].some(v => v?.transition_version && v.state === "PENDING"));
});

test("pending transition survives a missing task index and cannot restart the same task", async () => {
  const app = setup(), record = await start(app); app.fail(finalWrite);
  assertPending(await call(app, "/api/review/cancel", { ...binding(record), canceler: "synthetic-user", reason: "Test" }), record.task_id);
  app.rows.delete("task:" + record.task_id);
  app.fail(() => false); app.restart();
  assertPending(await call(app, "/api/review/task/" + record.task_id), record.task_id);
  assertPending(await call(app, "/api/review", { text: "New input", task_id: record.task_id }), record.task_id);
  assert.equal(app.calls(), 1);
});

test("admission committed without acknowledgement stays pending without applying the operation", async () => {
  const app = setup(), record = await start(app), put = app.storage.put;
  app.storage.put = async entries => {
    await put(entries);
    if (Object.values(entries).some(v => v?.transition_version && v.state === "PENDING")) throw new Error("SYNTHETIC_ADMISSION_ACK_LOSS");
  };
  assertPending(await call(app, "/api/review/cancel", { ...binding(record), canceler: "synthetic-user", reason: "Test" }), record.task_id);
  assert.equal(app.rows.get("run:" + record.run_id).status, "PENDING_RISK");
  app.storage.put = put; app.restart();
  assertPending(await call(app, "/api/review/cancel", { ...binding(record), canceler: "synthetic-user", reason: "Test" }), record.task_id);
});

test("committed state cannot be overwritten when storage throws a domain-shaped error after commit", async () => {
  const app = setup(), record = await start(app), put = app.storage.put; let writes = 0;
  app.storage.put = async entries => {
    if (finalWrite(entries)) writes++;
    await put(entries);
    if (finalWrite(entries)) throw Object.assign(new Error("Synthetic acknowledgement loss"), { name: "WorkflowError", code: "REVIEW_SERVICE_UNAVAILABLE", statusCode: 503 });
  };
  assertPending(await call(app, "/api/review/cancel", { ...binding(record), canceler: "synthetic-user", reason: "Test" }), record.task_id);
  app.storage.put = put; app.restart();
  const read = await call(app, "/api/review/task/" + record.task_id);
  assert.equal(read.status, 200); assert.equal(read.body.status, "CANCELLED");
  assert.equal(writes, 1);
  assert.equal(read.body.audit.events.filter(e => e.event_type === "task.cancelled").length, 1);
});

test("completed task, funding allocation and both admission markers commit in one write", async () => {
  const app = setup(), plan = (await call(app, "/api/funding-demo/plan", definition)).body;
  const record = await start(app, { action_parameters: parameters(plan) }); await approve(app, record);
  const put = app.storage.put; let checked = false;
  app.storage.put = async entries => {
    if (finalWrite(entries)) {
      const marks = Object.values(entries).filter(v => v?.transition_version);
      assert.equal(marks.length, 2); assert.ok(marks.every(m => m.state === "COMPLETED"));
      assert.equal(marks[0].transition_id, marks[1].transition_id);
      assert.equal(entries["funding:" + plan.plan_id].allocations.length, 1);
      assert.equal(entries["run:" + record.run_id].status, "SIMULATED"); checked = true;
    }
    await put(entries);
  };
  assert.equal((await call(app, "/api/review/simulate", binding(record))).status, 200);
  assert.equal(checked, true);
});

test("Risk delivery followed by a lost local write cannot dispatch again after restart", async t => {
  const app = setup(), record = await start(app);
  app.env.RISK_SERVICE_URL = "https://synthetic-risk.test/handoff";
  app.env.RISK_SERVICE_HMAC_SECRET = "synthetic-secret-not-a-real-credential";
  const previousFetch = globalThis.fetch; let sends = 0;
  globalThis.fetch = async () => { sends++; return new Response(JSON.stringify({ accepted: true }), { status: 202, headers: { "Content-Type": "application/json" } }); };
  t.after(() => { globalThis.fetch = previousFetch; });
  app.fail(finalWrite);
  assertPending(await call(app, "/api/review/risk-dispatch", binding(record)), record.task_id);
  assert.equal(sends, 1);
  app.fail(() => false); app.restart();
  assertPending(await call(app, "/api/review/risk-dispatch", binding(record)), record.task_id);
  assert.equal(sends, 1);
});

test("Risk delivery never starts when durable transition admission fails", async t => {
  const app = setup(), record = await start(app);
  app.env.RISK_SERVICE_URL = "https://synthetic-risk.test/handoff";
  app.env.RISK_SERVICE_HMAC_SECRET = "synthetic-secret-not-a-real-credential";
  const previousFetch = globalThis.fetch; let sends = 0;
  globalThis.fetch = async () => { sends++; throw new Error("Should not send"); };
  t.after(() => { globalThis.fetch = previousFetch; });
  app.fail(() => true);
  assertPending(await call(app, "/api/review/risk-dispatch", binding(record)), record.task_id);
  assert.equal(sends, 0);
});
