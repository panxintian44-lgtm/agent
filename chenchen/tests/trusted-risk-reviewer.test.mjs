import assert from "node:assert/strict";
import test from "node:test";
import worker, { ReviewService } from "../deployment/worker.js";
import ownerBridge from "../integrations/owner-bridge.js";

const riskSecret = "SYNTHETIC_RISK_SECRET_NOT_A_CREDENTIAL";
const approvalSecret = "SYNTHETIC_APPROVAL_SECRET_NOT_A_CREDENTIAL";
const reviewerId = "synthetic-risk-service-v1";
const strictEnv = {
  REQUIRE_TRUSTED_ACTORS: "true", REQUIRE_RISK_REVIEWER: "true",
  RISK_SERVICE_HMAC_SECRET: riskSecret, RISK_REVIEWER_ID: reviewerId
};

async function riskAuth(body, env = strictEnv, signature) {
  return ownerBridge.verifyOwnerRequest({ owner: "risk", body, env,
    headers: { "X-Risk-Signature": signature ?? await ownerBridge.signatureFor(body, riskSecret) } });
}

test("strict Risk identity requires both a server-side fixed reviewer and a valid signature", async () => {
  const auth = await riskAuth({ reviewer: reviewerId, decision: "APPROVE" });
  assert.equal(auth.verified, true);
  assert.equal(auth.fixed_actor_verified, true);
  assert.equal(auth.fixed_reviewer_verified, true);
  assert.equal(auth.identity_scope, "SERVICE");
  assert.equal(auth.end_user_identity_verified, false);
});

for (const flag of ["REQUIRE_TRUSTED_ACTORS", "REQUIRE_RISK_REVIEWER"]) {
  test(`${flag} rejects a signed callback when the fixed reviewer is missing`, async () => {
    await assert.rejects(riskAuth({ reviewer: reviewerId }, {
      [flag]: "true", RISK_SERVICE_HMAC_SECRET: riskSecret
    }), { code: "OWNER_REVIEWER_NOT_CONFIGURED", statusCode: 503 });
  });
  test(`${flag} rejects unsigned demo identity when the service secret is missing`, async () => {
    await assert.rejects(riskAuth({ reviewer: reviewerId }, {
      [flag]: "true", RISK_REVIEWER_ID: reviewerId
    }), { code: "OWNER_AUTH_NOT_CONFIGURED", statusCode: 503 });
  });
  test(`${flag} rejects misspelled boolean configuration instead of silently downgrading`, async () => {
    await assert.rejects(riskAuth({ reviewer: reviewerId }, {
      ...strictEnv, [flag]: "ture"
    }), { code: "OWNER_CONFIG_INVALID", statusCode: 503 });
  });
  test(`${flag} rejects the compatibility secret name without the primary Risk secret`, async () => {
    await assert.rejects(riskAuth({ reviewer: reviewerId }, {
      [flag]: "true", RISK_HMAC_SECRET: riskSecret, RISK_REVIEWER_ID: reviewerId
    }), { code: "OWNER_CONFIG_INVALID", statusCode: 503 });
  });
}

for (const actor of ["other-risk-service", "SYNTHETIC-RISK-SERVICE-V1", "", undefined, ` ${reviewerId}`, `${reviewerId}\n`]) {
  test(`a valid signature cannot authenticate the wrong fixed reviewer ${String(actor)}`, async () => {
    await assert.rejects(riskAuth({ reviewer: actor, decision: "APPROVE" }), {
      code: "OWNER_ACTOR_MISMATCH", statusCode: 403
    });
  });
}

test("configured reviewer is enforced even when strict flags are not enabled", async () => {
  await assert.rejects(riskAuth({ reviewer: "other" }, {
    RISK_SERVICE_HMAC_SECRET: riskSecret, RISK_REVIEWER_ID: reviewerId
  }), { code: "OWNER_ACTOR_MISMATCH" });
});

for (const configured of [" ", "x".repeat(201), ` ${reviewerId}`, `${reviewerId} `, `${reviewerId}\n`, `${reviewerId}\u0000tail`]) {
  test(`strict Risk identity rejects invalid configured reviewer ${JSON.stringify(configured)}`, async () => {
    await assert.rejects(riskAuth({ reviewer: reviewerId }, {
      ...strictEnv, RISK_REVIEWER_ID: configured
    }), { code: "OWNER_CONFIG_INVALID", statusCode: 503 });
  });
}

test("a fixed reviewer accepts the 200-character service identity boundary", async () => {
  const reviewer = "x".repeat(200);
  const auth = await riskAuth({ reviewer }, { ...strictEnv, RISK_REVIEWER_ID: reviewer });
  assert.equal(auth.fixed_actor_verified, true);
});

test("a configured fixed reviewer cannot fall back to an unsigned demo without strict flags", async () => {
  await assert.rejects(riskAuth({ reviewer: reviewerId }, { RISK_REVIEWER_ID: reviewerId }), {
    code: "OWNER_AUTH_NOT_CONFIGURED", statusCode: 503
  });
});

test("strict mode uses the primary secret even when a compatibility binding also exists", async () => {
  const env = { ...strictEnv, RISK_HMAC_SECRET: "SYNTHETIC_DIFFERENT_COMPATIBILITY_SECRET" };
  assert.equal((await riskAuth({ reviewer: reviewerId }, env)).fixed_reviewer_verified, true);
  await assert.rejects(riskAuth({ reviewer: reviewerId }, env,
    await ownerBridge.signatureFor({ reviewer: reviewerId }, env.RISK_HMAC_SECRET)), {
    code: "OWNER_AUTH_INVALID", statusCode: 401
  });
});

test("legacy compatibility secret remains a service signature without a fixed actor or end user", async () => {
  const auth = await riskAuth({ reviewer: "legacy-synthetic-label" }, { RISK_HMAC_SECRET: riskSecret });
  assert.equal(auth.verified, true);
  assert.equal(auth.fixed_actor_verified, false);
  assert.equal(auth.fixed_reviewer_verified, false);
  assert.equal(auth.identity_scope, "SERVICE");
  assert.equal(auth.end_user_identity_verified, false);
});

test("Risk readiness reports a strict alias-only configuration as not ready", () => {
  const env = { REQUIRE_RISK_REVIEWER: "true", RISK_REVIEWER_ID: reviewerId, RISK_HMAC_SECRET: riskSecret };
  const status = ownerBridge.ownerConfigurationStatus("risk", env);
  assert.equal(status.secret_name, "RISK_HMAC_SECRET");
  assert.equal(status.configuration_error, "OWNER_CONFIG_INVALID");
  const risk = ownerBridge.riskIdentityStatus(env);
  assert.equal(risk.fixed_reviewer_required, true);
  assert.equal(risk.fixed_reviewer_configured, true);
  assert.equal(risk.strict_settings_valid, true);
  assert.equal(risk.callback_identity_ready, false);
});

test("correct actor labels never bypass signature validation", async () => {
  await assert.rejects(riskAuth({ reviewer: reviewerId }, strictEnv, "sha256=invalid"), {
    code: "OWNER_AUTH_INVALID", statusCode: 401
  });
});

test("legacy signed Risk mode does not claim a fixed actor or end-user identity", async () => {
  const auth = await riskAuth({ reviewer: "legacy-synthetic-label" }, { RISK_SERVICE_HMAC_SECRET: riskSecret });
  assert.equal(auth.verified, true);
  assert.equal(auth.fixed_actor_verified, false);
  assert.equal(auth.end_user_identity_verified, false);
});

test("unsigned non-strict demo remains visibly unverified", async () => {
  const auth = await ownerBridge.verifyOwnerRequest({ owner: "risk", body: { reviewer: "demo-label" }, env: {}, headers: {} });
  assert.equal(auth.mode, "DEMO_UNVERIFIED");
  assert.equal(auth.verified, false);
  assert.equal(auth.fixed_actor_verified, false);
  assert.equal(auth.end_user_identity_verified, false);
});

test("an approval service HMAC does not prove the named end user approved", async () => {
  const body = { approver: "synthetic-user", decision: "APPROVE" };
  const auth = await ownerBridge.verifyOwnerRequest({ owner: "approval", body,
    env: { REQUIRE_TRUSTED_ACTORS: "true", APPROVAL_SERVICE_HMAC_SECRET: approvalSecret },
    headers: { "X-Approval-Signature": await ownerBridge.signatureFor(body, approvalSecret) } });
  assert.equal(auth.verified, true);
  assert.equal(auth.identity_scope, "SERVICE");
  assert.equal(auth.end_user_identity_verified, false);
});

function setup() {
  const rows = new Map(); let modelCalls = 0;
  const storage = {
    async get(key) { return structuredClone(rows.get(key)); },
    async put(entries) { for (const [key, value] of Object.entries(entries)) rows.set(key, structuredClone(value)); }
  };
  const env = { ...strictEnv, APPROVAL_SERVICE_HMAC_SECRET: approvalSecret,
    MODEL_PROVIDER: "workers_ai", MODEL_MAX_ATTEMPTS: "1", RATE_LIMIT_PER_MINUTE: "0",
    AI: { run: async () => { modelCalls++; return { id: "SYNTHETIC_RESPONSE_NOT_LIVE", response: {
      summary: "Synthetic signed handoff", proposed_action: "HOLD_FOR_REVIEW", risk_level: "unknown",
      action_reason: "Independent Risk and confirmation required", evidence: [], missing_information: []
    } }; } } };
  const service = new ReviewService({ storage }, env);
  env.REVIEW_SERVICE = { idFromName: x => x, get: () => service };
  return { rows, env, modelCalls: () => modelCalls };
}

async function call(app, path, body, signatureHeader, secret) {
  const headers = { "Content-Type": "application/json" };
  if (signatureHeader) headers[signatureHeader] = await ownerBridge.signatureFor(body, secret);
  const response = await worker.fetch(new Request("https://synthetic.test" + path, body === undefined ? {} : {
    method: "POST", headers, body: JSON.stringify(body)
  }), app.env);
  return { status: response.status, body: await response.json() };
}

function callback(record, reviewer = reviewerId) {
  return { callback_version: "risk-callback.v1", handoff_id: record.risk_handoff.handoff_id,
    task_id: record.task_id, request_id: record.request_id, run_id: record.run_id,
    audit_id: record.audit.audit_id, proposal_sha256: record.proposed_action.proposal_sha256,
    decision: "APPROVE", reviewer, reason: "Synthetic signed service callback" };
}

test("capabilities separate configured service signatures from unimplemented end-user authentication", async () => {
  const app = setup();
  const result = await call(app, "/api/review/capabilities");
  assert.equal(result.status, 200);
  assert.equal(result.body.risk.fixed_reviewer_configured, true);
  assert.equal(result.body.risk.fixed_reviewer_required, true);
  assert.equal(result.body.risk.callback_identity_ready, true);
  assert.equal(result.body.approval.service_signature_ready, true);
  assert.equal(result.body.approval.trusted_identity_ready, false);
  assert.equal(result.body.approval.end_user_identity_ready, false);
  assert.equal(result.body.approval.demo_actor_labels_allowed, false);
  assert.equal(result.body.execution.allowed, false);
  assert.equal(result.body.acceptance.joint_acceptance, false);
  assert.equal(app.modelCalls(), 0);
});

test("capabilities report malformed or incomplete strict identity configuration as not ready", async () => {
  for (const patch of [{ RISK_REVIEWER_ID: "" }, { RISK_REVIEWER_ID: "x".repeat(201) },
    { REQUIRE_RISK_REVIEWER: "ture" }, { RISK_SERVICE_HMAC_SECRET: "" }]) {
    const app = setup(); Object.assign(app.env, patch);
    const result = await call(app, "/api/review/capabilities");
    assert.equal(result.status, 200);
    assert.equal(result.body.risk.callback_identity_ready, false);
    assert.equal(result.body.execution.allowed, false);
    assert.equal(app.modelCalls(), 0);
  }
});

test("a signed wrong reviewer cannot mutate task, approve, simulate or trigger more inference", async () => {
  const app = setup();
  const created = (await call(app, "/api/review", { text: "Synthetic rent protection", capability: "SIMULATION_ONLY" })).body;
  const original = structuredClone(app.rows.get("run:" + created.run_id));
  const result = await call(app, "/api/review/risk-callback", callback(created, "wrong-service"), "X-Risk-Signature", riskSecret);
  assert.equal(result.status, 403);
  assert.equal(result.body.error.code, "OWNER_ACTOR_MISMATCH");
  assert.deepEqual(app.rows.get("run:" + created.run_id), original);
  const bind = { task_id: created.task_id, proposal_sha256: created.proposed_action.proposal_sha256 };
  const approved = await call(app, "/api/review/approval", { ...bind, decision: "APPROVE", approver: "synthetic-user", reason: "Synthetic test" }, "X-Approval-Signature", approvalSecret);
  assert.equal(approved.status, 409);
  assert.equal((await call(app, "/api/review/simulate", bind)).status, 409);
  assert.equal(app.modelCalls(), 1);
  assert.equal(app.rows.get("run:" + created.run_id).execution.receipt, null);
});

test("valid fixed service identity does not upgrade a read-only task", async () => {
  const app = setup();
  const created = (await call(app, "/api/review", { text: "Synthetic read-only review", capability: "REVIEW_ONLY" })).body;
  const checked = await call(app, "/api/review/risk-callback", callback(created), "X-Risk-Signature", riskSecret);
  assert.equal(checked.status, 200);
  assert.equal(checked.body.workflow.risk_decision.auth.fixed_actor_verified, true);
  const bind = { task_id: created.task_id, proposal_sha256: created.proposed_action.proposal_sha256 };
  const approved = await call(app, "/api/review/approval", { ...bind, decision: "APPROVE", approver: "synthetic-user", reason: "Synthetic test" }, "X-Approval-Signature", approvalSecret);
  assert.equal(approved.status, 409);
  assert.equal(approved.body.error.code, "SIMULATION_CAPABILITY_REQUIRED");
  assert.equal((await call(app, "/api/review/simulate", bind)).status, 409);
  assert.equal(app.rows.get("run:" + created.run_id).execution.receipt, null);
  assert.equal(app.modelCalls(), 1);
});

test("signed service test doubles preserve one task/hash through explicit PAPER simulation", async () => {
  const app = setup();
  const created = (await call(app, "/api/review", { text: "Synthetic explicit PAPER", capability: "SIMULATION_ONLY" })).body;
  const checked = await call(app, "/api/review/risk-callback", callback(created), "X-Risk-Signature", riskSecret);
  assert.equal(checked.status, 200);
  const bind = { task_id: created.task_id, proposal_sha256: created.proposed_action.proposal_sha256 };
  const approved = await call(app, "/api/review/approval", { ...bind, decision: "APPROVE", approver: "synthetic-user", reason: "SERVICE_TEST_DOUBLE_NOT_END_USER_LOGIN" }, "X-Approval-Signature", approvalSecret);
  assert.equal(approved.status, 200);
  assert.equal(approved.body.approval.auth.end_user_identity_verified, false);
  const simulated = await call(app, "/api/review/simulate", bind);
  assert.equal(simulated.status, 200);
  assert.equal(simulated.body.status, "SIMULATED");
  assert.equal(simulated.body.task_id, created.task_id);
  assert.equal(simulated.body.proposed_action.proposal_sha256, bind.proposal_sha256);
  assert.equal(simulated.body.execution.receipt.side_effects, false);
  assert.equal(simulated.body.execution.execution_allowed, false);
  assert.equal(simulated.body.audit.audit_id, created.audit.audit_id);
  assert.equal(app.modelCalls(), 1);
});
