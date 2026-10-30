"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { ReviewWorkflowStore } = require("../integrations/review-workflow");
const { buildReviewEvidence, sha256 } = require("../integrations/review-evidence");
const { exportFile } = require("../scripts/export-review-evidence");

async function example(status = "SIMULATED") {
  const proposal = { summary: "PRIVATE_SYNTHETIC_RESPONSE", proposed_action: "HOLD_FOR_REVIEW", risk_level: "unknown", action_reason: "Synthetic", missing_information: [], evidence: [] };
  const store = new ReviewWorkflowStore({ modelRunner: async () => {
    if (status === "MODEL_FAILED") throw Object.assign(new Error("Synthetic provider failure"), { code: "MODEL_PROVIDER_UNAVAILABLE" });
    return { run_id: "synthetic-run-" + randomUUID(), source: "model", status: "PROPOSED", input: { input_sha256: "a".repeat(64) },
      model_response: { provider_response_id: "synthetic-provider-response", raw_text: JSON.stringify(proposal), proposal },
      audit: { audit_id: "synthetic-audit-" + randomUUID(), events: [] } };
  } });
  let created;
  try { created = await store.start({ capability: "SIMULATION_ONLY", text: "PRIVATE_SYNTHETIC_INPUT", data_mode: "SYNTHETIC_REPLAY", action_parameters: { amount: 4000 } }); }
  catch (error) { if (status === "MODEL_FAILED") return error.workflowRecord; throw error; }
  if (status === "PENDING_RISK") return created;
  const input = { task_id: created.task_id, proposal_sha256: created.proposed_action.proposal_sha256 };
  const reviewed = await store.decideRisk({ ...input, decision: status === "REJECTED" ? "REJECT" : "APPROVE", reviewer: "synthetic-risk", reason: "PRIVATE_SYNTHETIC_REASON" });
  if (status === "REJECTED" || status === "PENDING_APPROVAL") return reviewed;
  await store.decideApproval({ ...input, decision: "APPROVE", approver: "synthetic-user", reason: "Synthetic confirmation" });
  return store.simulate(input);
}

test("offline report distinguishes complete PAPER, waiting, rejection and model failure without claiming joint acceptance", async () => {
  for (const status of ["SIMULATED", "PENDING_RISK", "PENDING_APPROVAL", "REJECTED", "MODEL_FAILED"]) {
    const record = await example(status), before = structuredClone(record);
    const result = buildReviewEvidence(record);
    assert.equal(result.manifest.consistency_status, "CONSISTENT_WITH_LIMITS", JSON.stringify(result.manifest.findings));
    assert.equal(result.manifest.workflow_status, status);
    assert.equal(result.manifest.joint_acceptance, false);
    assert.equal(result.manifest.signatures_reverified, false);
    assert.equal(result.manifest.record_is_not_authenticated, true);
    assert.deepEqual(record, before);
  }
});

test("default text omits free-form input, model response and reasons; explicit opt-in includes them", async () => {
  const record = await example();
  const summary = buildReviewEvidence(record);
  for (const marker of ["PRIVATE_SYNTHETIC_INPUT", "PRIVATE_SYNTHETIC_RESPONSE", "PRIVATE_SYNTHETIC_REASON"]) {
    assert.equal(summary.text.includes(marker), false);
    assert.equal(JSON.stringify(summary.manifest).includes(marker), false);
    assert.equal(buildReviewEvidence(record, { includeContent: true }).text.includes(marker), true);
  }
  assert.ok(summary.manifest.findings.some(x => x.code === "ACTOR_NOT_VERIFIED_IN_RECORD"));
});

test("changed amount or mismatched receipt and event identifiers cannot produce a clean report", async () => {
  for (const mutate of [r => { r.proposed_action.action_parameters.amount = 8000; },
    r => { r.execution.receipt.task_id = "other-task"; },
    r => { r.audit.events.at(-1).payload.trace.audit_id = "other-audit"; },
    r => { r.audit.events.push(structuredClone(r.audit.events[0])); }]) {
    const record = await example(); mutate(record);
    assert.equal(buildReviewEvidence(record).manifest.consistency_status, "INCONSISTENT");
  }
});

test("missing Risk or approval evidence, expired approval and real effects are reported as errors", async () => {
  for (const mutate of [r => { r.risk_decision = null; }, r => { r.approval.status = "PENDING"; },
    r => { r.audit.events = r.audit.events.filter(e => e.event_type !== "approval.approved"); },
    r => { r.approval.expires_at = "2000-01-01T00:00:00.000Z"; }, r => { r.execution.receipt.side_effects = true; }]) {
    const record = await example(); mutate(record);
    assert.equal(buildReviewEvidence(record).manifest.consistency_status, "INCONSISTENT");
  }
});

test("claimed actor verification is not reverified and inconsistent actor claims are flagged", async () => {
  const record = await example();
  record.risk_decision.auth = { owner: "risk", actor: record.risk_decision.reviewer, mode: "HMAC_SHA256", verified: true };
  assert.equal(buildReviewEvidence(record).manifest.signatures_reverified, false);
  record.risk_decision.auth.actor = "different-user";
  assert.ok(buildReviewEvidence(record).manifest.findings.some(x => x.code === "AUTH_CLAIM_MISMATCH"));
});

test("export hashes actual source and text bytes, preserves input and refuses an existing directory", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "review-evidence-test-"));
  const input = path.join(root, "synthetic.json"), output = path.join(root, "export");
  const bytes = Buffer.from("\uFEFF" + JSON.stringify(await example()), "utf8");
  fs.writeFileSync(input, bytes, { flag: "wx" });
  const manifest = exportFile(input, output);
  assert.equal(manifest.source_sha256, sha256(bytes));
  assert.equal(manifest.files[0].sha256, sha256(fs.readFileSync(path.join(output, "任务记录.txt"))));
  assert.deepEqual(fs.readFileSync(input), bytes);
  const saved = fs.readFileSync(path.join(output, "manifest.json"));
  assert.throws(() => exportFile(input, output), e => e.code === "EEXIST");
  assert.deepEqual(fs.readFileSync(path.join(output, "manifest.json")), saved);
});

test("CLI returns exit 2 for inconsistent records while preserving an inspectable report", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "review-evidence-cli-"));
  const record = await example(); record.execution.receipt.task_id = "wrong-task";
  const input = path.join(root, "synthetic.json"), output = path.join(root, "export");
  fs.writeFileSync(input, JSON.stringify(record), { flag: "wx" });
  const result = spawnSync(process.execPath, [path.resolve(__dirname, "../scripts/export-review-evidence.js"), "--input", input, "--output-dir", output], { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 2, result.stderr);
  assert.equal(JSON.parse(fs.readFileSync(path.join(output, "manifest.json"))).consistency_status, "INCONSISTENT");
  assert.throws(() => buildReviewEvidence({ contract_version: "legacy-review.v0", task_id: "partial" }), /完整工作流/);
});
