"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { ReviewWorkflowStore } = require("../../../../chenchen/integrations/review-workflow.js");
const { buildRiskHandoffPackage, validateRiskCallback, CALLBACK_FIELDS } = require("../../../../chenchen/integrations/risk-handoff.js");
const { buildRiskCallbackDraft } = require("../risk-callback.cjs");
const { assessmentFor, makeFixture, POLICY_VERSION } = require("../fixture-data.cjs");
const officialSchema = require("../../../../chenchen/contracts/risk-handoff.v1.schema.json");
const directory = path.resolve(__dirname, "../../../../docs/safety-risk-eval/interface-adapters-v1/examples");
const read = name => JSON.parse(fs.readFileSync(path.join(directory, name), "utf8"));

async function start() {
  let sequence = 0;
  const store = new ReviewWorkflowStore({ modelRunner: async input => {
    sequence++;
    return { run_id: `fixture-compatible-run-${sequence}`, status: "PROPOSED", source: "model", input: { kind: input.kind, input_sha256: "a".repeat(64) },
      model_response: { call_succeeded: true, model: "TEST_DOUBLE_NOT_A_LIVE_CALL", provider_response_id: `fixture-response-${sequence}`, proposal: { proposed_action: "HOLD_FOR_REVIEW", action_reason: "Verify confirmed rent protection", risk_level: "medium" } },
      audit: { audit_id: `fixture-compatible-audit-${sequence}`, events: [] } };
  } });
  const request = { schema_version: "model-review.v1", kind: "bill", text: "Synthetic confirmed funds only", data_mode: "SYNTHETIC_REPLAY", execution_mode: "PAPER", capability: "SIMULATION_ONLY", policy_version: POLICY_VERSION, action_parameters: { amount: "2000.00", currency: "CNY", amount_unit: "YUAN" } };
  const record = await store.start(request);
  return { store, record, request };
}
function draftFor(record, decision) {
  const handoff = buildRiskHandoffPackage(record);
  return buildRiskCallbackDraft({ handoff, risk_result: assessmentFor(handoff, decision), reviewer: "fixture-module4-owner" });
}

test("stored four-state examples reproduce the adapter and preserve frozen callback keys", () => {
  const manifest = read("manifest.json");
  assert.equal(manifest.real_model_called, false); assert.equal(manifest.callback_sent, false);
  const tenFields = ["callback_version", "handoff_id", "task_id", "request_id", "run_id", "audit_id", "proposal_sha256", "decision", "reviewer", "reason"];
  assert.deepEqual(CALLBACK_FIELDS, tenFields); assert.deepEqual([...officialSchema.$defs.CallbackRequest.required].sort(), [...tenFields].sort());
  for (const item of manifest.cases) {
    const input = read(item.input), result = buildRiskCallbackDraft(input); assert.deepEqual(result, read(item.output));
    assert.equal(result.dispatch_allowed, false); assert.equal(result.execution_allowed, false);
    for (const field of officialSchema.$defs.HandoffPackage.required) assert.ok(Object.hasOwn(input.handoff, field), field);
    for (const field of Object.keys(input.handoff)) assert.ok(Object.hasOwn(officialSchema.$defs.HandoffPackage.properties, field), field);
    if (result.callback) {
      assert.deepEqual(Object.keys(result.callback).sort(), [...tenFields].sort());
      const handoff = input.handoff, record = { task_id: handoff.task_id, request_id: handoff.request_id, run_id: handoff.run_id, proposed_action: handoff.proposal, risk_handoff: { handoff_id: handoff.handoff_id }, audit: { audit_id: handoff.audit_id } };
      assert.deepEqual(validateRiskCallback(result.callback, record), result.callback);
    } else assert.equal(result.risk_decision, "ERROR");
  }
});

test("actual Core generated handoff accepts ALLOW mapping but keeps human approval pending", async () => {
  const { store, record } = await start(), draft = draftFor(record, "ALLOW");
  const response = await store.receiveRiskCallback(draft.callback), current = response.workflow;
  assert.equal(response.callback_status, "RECORDED"); assert.equal(current.risk_decision.decision, "APPROVE"); assert.equal(current.status, "PENDING_APPROVAL");
  assert.equal(current.execution.execution_allowed, false); assert.equal(current.execution.simulation_allowed, false);
  await assert.rejects(store.simulate({ task_id: current.task_id, proposal_sha256: current.proposed_action.proposal_sha256 }), error => error.code === "EXECUTION_BLOCKED");
  const count = store.getByTaskId(record.task_id).audit.events.length, duplicate = await store.receiveRiskCallback(structuredClone(draft.callback));
  assert.equal(duplicate.callback_status, "DUPLICATE"); assert.equal(duplicate.workflow.audit.events.length, count);
});

for (const decision of ["REVIEW", "BLOCK"]) test(`actual Core ${decision} callback pauses execution and cannot be replaced`, async () => {
  const { store, record } = await start(), draft = draftFor(record, decision), response = await store.receiveRiskCallback(draft.callback);
  assert.equal(response.workflow.status, decision === "REVIEW" ? "PENDING_RISK" : "REJECTED"); assert.equal(response.workflow.execution.execution_allowed, false);
  assert.equal((await store.receiveRiskCallback(draft.callback)).callback_status, "DUPLICATE");
  await assert.rejects(store.receiveRiskCallback({ ...draft.callback, decision: "APPROVE" }), error => error.code === "RISK_CALLBACK_CONFLICT");
  await assert.rejects(store.simulate({ task_id: record.task_id, proposal_sha256: record.proposed_action.proposal_sha256 }), error => error.code === "EXECUTION_BLOCKED");
  assert.throws(() => draftFor(store.getByTaskId(record.task_id), "ALLOW"), error => error.code === "HANDOFF_NOT_PENDING");
});

test("ERROR creates no Core callback or decision and can be diagnosed before a first callback", async () => {
  const { store, record } = await start(), draft = draftFor(record, "ERROR");
  assert.equal(draft.callback, null); assert.equal(draft.status, "ERROR_HELD"); assert.equal(store.getByTaskId(record.task_id).risk_decision, null);
  assert.equal(store.getByTaskId(record.task_id).status, "PENDING_RISK");
  await assert.rejects(store.simulate({ task_id: record.task_id, proposal_sha256: record.proposed_action.proposal_sha256 }), error => error.code === "EXECUTION_BLOCKED");
});

test("after REQUEST_MORE_INFO a revised scenario receives a new task and linkage", async () => {
  const { store, record, request } = await start(), first = draftFor(record, "REVIEW"); await store.receiveRiskCallback(first.callback);
  const revised = await store.start({ ...request, source_task_id: record.task_id, action_parameters: { ...request.action_parameters, amount: "1000.00" } });
  assert.notEqual(revised.task_id, record.task_id); assert.equal(revised.reviewed_input.source_task_id, record.task_id);
  assert.equal(Object.hasOwn(buildRiskHandoffPackage(revised), "source_task_id"), false);
  assert.equal((await store.receiveRiskCallback(draftFor(revised, "ALLOW").callback)).workflow.status, "PENDING_APPROVAL");
  assert.equal(store.getByTaskId(record.task_id).risk_decision.decision, "REQUEST_MORE_INFO");
});

test("callback cannot introduce approval, action overrides or adapter metadata", async () => {
  const { store, record } = await start(), callback = draftFor(record, "ALLOW").callback;
  for (const field of ["execution_allowed", "risk_check_id", "approval", "action_parameters", "local_task_id"]) {
    await assert.rejects(store.receiveRiskCallback({ ...callback, [field]: true }), error => error.code === "INVALID_RISK_CALLBACK");
  }
  assert.equal(store.getByTaskId(record.task_id).risk_decision, null);
});

test("synthetic provider fixtures remain explicitly labelled and do not assert live acceptance", () => {
  for (const decision of ["ALLOW", "REVIEW", "BLOCK", "ERROR"]) assert.equal(makeFixture(decision).handoff.model.model, "TEST_DOUBLE_NOT_A_LIVE_MODEL");
});
