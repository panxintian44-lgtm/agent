"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { ReviewWorkflowStore } = require("../integrations/review-workflow");

const proposal = { summary: "Synthetic context isolation", proposed_action: "HOLD_FOR_REVIEW",
  action_reason: "Synthetic context isolation", risk_level: "low", evidence: [], missing_information: [] };
function fixture() {
  let calls = 0;
  const store = new ReviewWorkflowStore({ modelRunner: async input => {
    calls++;
    return { run_id: "synthetic-context-" + randomUUID(), source: "model", status: "PROPOSED",
      input: { kind: input.kind, source: input.source, input_sha256: "a".repeat(64) },
      model_response: { model: "TEST_DOUBLE_NOT_LIVE", call_succeeded: true, proposal },
      audit: { audit_id: "synthetic-audit-" + randomUUID(), events: [] } };
  } });
  const input = { text: "Synthetic context only", session_id: "synthetic-session-A", idempotency_key: "synthetic-context-key" };
  return { store, input, calls: () => calls };
}

test("an identical retry in the same declared session keeps one model proposal", async () => {
  const f = fixture(), first = await f.store.start(f.input), retry = await f.store.start(f.input);
  assert.equal(retry.task_id, first.task_id); assert.equal(f.calls(), 1);
  assert.equal(retry.execution.receipt, null);
});

for (const [label, change] of [["session", { session_id: "synthetic-session-B" }], ["task", { task_id: "synthetic-other-task" }]]) {
  test(`a reused idempotency key cannot change declared ${label} or disclose the original task`, async () => {
    const f = fixture(), first = await f.store.start(f.input);
    await assert.rejects(f.store.start({ ...f.input, ...change }), error => {
      assert.equal(error.code, "IDEMPOTENCY_CONTEXT_MISMATCH");
      assert.equal(error.record, null); assert.equal(error.taskId, null); assert.equal(error.runId, null);
      return true;
    });
    assert.equal(f.calls(), 1); assert.equal(f.store.getByTaskId(first.task_id).execution.receipt, null);
  });
}

test("legacy retries without declared session identifiers retain their existing fingerprint", async () => {
  const f = fixture(); delete f.input.session_id;
  const first = await f.store.start(f.input), retry = await f.store.start(f.input);
  assert.equal(retry.task_id, first.task_id); assert.equal(f.calls(), 1);
});

for (const [label, change] of [["session", { session_id: "synthetic-session-B" }], ["task", { task_id: "synthetic-other-task" }]]) {
  test(`HTTP retry rejects a changed ${label} before returning a stored record`, async () => {
    const { default: worker, ReviewService } = await import("../deployment/worker.js");
    const rows = new Map(); let calls = 0;
    const env = { MODEL_PROVIDER: "workers_ai", MODEL_DISABLE_RULE_FALLBACK: "true", RATE_LIMIT_PER_MINUTE: "0",
      AI: { run: async () => { calls++; return { response: proposal }; } } };
    const service = new ReviewService({ storage: {
      get: async key => structuredClone(rows.get(key)),
      put: async entries => { for (const [key, value] of Object.entries(entries)) rows.set(key, structuredClone(value)); }
    } }, env);
    env.REVIEW_SERVICE = { idFromName: name => name, get: () => service };
    const send = body => worker.fetch(new Request("https://synthetic.invalid/api/review", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
    }), env);
    const input = { text: "Synthetic HTTP context only", session_id: "synthetic-session-A", idempotency_key: "synthetic-http-key" };
    const firstResponse = await send(input); assert.equal(firstResponse.status, 200);
    const first = await firstResponse.json(), denied = await send({ ...input, ...change });
    assert.equal(denied.status, 409);
    const body = await denied.json(); assert.equal(body.error.code, "IDEMPOTENCY_CONTEXT_MISMATCH");
    assert.equal(JSON.stringify(body).includes(first.task_id), false);
    assert.equal(JSON.stringify(body).includes(first.run_id), false);
    assert.equal(calls, 1); assert.equal(rows.get("run:" + first.run_id).execution.receipt, null);
  });
}

for (const [label, change] of [["session", { session_id: "synthetic-session-B" }], ["task", { task_id: "synthetic-other-task" }]]) {
  test(`HTTP retry rejects a changed ${label} after a lost final write without disclosing reservation context`, async () => {
    const { default: worker, ReviewService } = await import("../deployment/worker.js");
    const rows = new Map(); let calls = 0, rejectFinalWrite = true;
    const env = { MODEL_PROVIDER: "workers_ai", MODEL_DISABLE_RULE_FALLBACK: "true", RATE_LIMIT_PER_MINUTE: "0",
      AI: { run: async () => { calls++; return { response: proposal }; } } };
    const service = new ReviewService({ storage: {
      get: async key => structuredClone(rows.get(key)),
      put: async entries => {
        if (rejectFinalWrite && Object.keys(entries).some(key => key.startsWith("run:"))) throw new Error("SYNTHETIC_LOST_FINAL_WRITE");
        for (const [key, value] of Object.entries(entries)) rows.set(key, structuredClone(value));
      }
    } }, env);
    env.REVIEW_SERVICE = { idFromName: name => name, get: () => service };
    const send = body => worker.fetch(new Request("https://synthetic.invalid/api/review", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
    }), env);
    const input = { text: "Synthetic HTTP unresolved context", session_id: "synthetic-session-A",
      task_id: "synthetic-original-task", idempotency_key: "synthetic-unresolved-key" };
    const firstResponse = await send(input); assert.equal(firstResponse.status, 503);
    const first = await firstResponse.json();
    assert.equal(first.error.code, "REVIEW_SERVICE_UNAVAILABLE");
    assert.equal(first.trace.task_id, input.task_id);
    assert.equal([...rows.keys()].some(key => key.startsWith("run:")), false);
    rejectFinalWrite = false;

    const denied = await send({ ...input, ...change });
    assert.equal(denied.status, 409);
    const body = await denied.json();
    assert.equal(body.error.code, "IDEMPOTENCY_CONTEXT_MISMATCH");
    assert.equal(body.workflow, null);
    for (const field of ["request_id", "task_id", "session_id", "run_id", "audit_id", "handoff_id"]) {
      assert.equal(body.trace[field], null);
      if (first.trace[field]) assert.equal(JSON.stringify(body).includes(first.trace[field]), false);
    }

    const sameContext = await send(input);
    assert.equal(sameContext.status, 503);
    const unresolved = await sameContext.json();
    assert.equal(unresolved.error.code, "REVIEW_SERVICE_UNAVAILABLE");
    assert.equal(unresolved.trace.task_id, first.trace.task_id);
    const legacy = { ...input }; delete legacy.session_id;
    assert.equal((await send(legacy)).status, 503);
    assert.equal(calls, 1);
    assert.equal([...rows.keys()].some(key => key.startsWith("run:")), false);
  });
}
