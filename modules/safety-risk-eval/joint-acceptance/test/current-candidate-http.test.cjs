"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { runCurrentCandidateHttp } = require("../current-candidate-http.cjs");

test("current full Core Worker and signed Risk HTTP integration remain simulated and fail closed", async () => {
  const result = await runCurrentCandidateHttp();
  assert.equal(result.failed, 0, JSON.stringify(result.failures));
  assert.equal(result.passed, 18);
  assert.equal(result.source_manifest.core_import, "CURRENT_FULL_WORKER_DIRECT_IMPORT_NO_PINNED_OLD_SNAPSHOT");
  assert.equal(result.formal_joint_acceptance, false);
  assert.equal(result.deployed, false);
  assert.equal(result.real_model_calls, 0);
  assert.equal(result.real_financial_operations, 0);
  const normal = result.cases.find(row => row.case_id === "signed_simulation_same_task_audit_and_duplicate_receipt");
  assert.equal(normal.simulated_receipt_count, 1);
  assert.equal(normal.simulated_allocation_count, 1);
  const readonly = result.cases.find(row => row.case_id === "readonly_signed_allow_and_confirmation_cannot_upgrade");
  assert.equal(readonly.simulated_receipt_count, 0);
  assert.equal(readonly.simulated_allocation_count, 0);
  const forged = result.cases.find(row => row.case_id === "signed_but_wrong_fixed_reviewer");
  assert.equal(forged.call_counts.approval_http, 0);
  assert.equal(forged.call_counts.simulate_http, 0);
});
