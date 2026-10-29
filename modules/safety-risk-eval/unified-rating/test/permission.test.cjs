"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { authorizeCapability } = require("../permission.cjs");
const matrix = require("../../../../docs/safety-risk-eval/unified-rating-v1/permission-matrix.json");

const now = "2026-10-29T12:00:00+08:00";
function fixture(capability = "financial_data.read") {
  const request = { capability, resource_id: "synthetic-account-1", purpose: "CURRENT_ANALYSIS", audience: "workbench-risk-service", environment: "TEAM_SYNTHETIC" };
  const definition = matrix.capabilities.find(row => row.id === capability);
  const versions = {}, version_applicability = {};
  for (const key of definition?.scope.versions || ["authorization_version"]) {
    const conditional = /^(.*)_if_(available|used)$/.exec(key);
    if (conditional) version_applicability[conditional[1]] = false;
    else versions[key] = key.endsWith("sha256") ? "a".repeat(64) : "v1";
  }
  const confirmation = { "execution.reconcile": "OWNER_EXECUTION_READ_GRANT" }[capability] || definition?.confirmation_type || "COMPLETE_PAPER_PLAN_APPROVAL";
  const context = { session_verified: true, subject_id: "synthetic-user-1", actor_id: "workbench-server", actor_type: capability === "execution.reconcile" ? "VERIFIED_RESOURCE_OWNER" : "AUTHENTICATED_SCOPED_SERVICE_ACTOR", service_verified: true, actor_capabilities: [capability], resource_id: request.resource_id, resource_owner: "synthetic-user-1", environment: request.environment, versions, version_applicability, now, validation_status: "READY", grants: [] };
  if (capability === "model_context.send") {
    request.fields = ["cash", "purposes"];
    context.model_recipients = [{ audience: request.audience, environment: request.environment, recipient_version: versions.model_recipient_version }];
  }
  context.grants.push({ grant_id: "synthetic-grant-1", subject_id: context.subject_id, actor_id: context.actor_id, ...request, ...(request.fields ? { fields: [...request.fields] } : {}), issued_at: "2026-10-29T11:55:00+08:00", expires_at: "2026-10-29T12:05:00+08:00", revoked: false, versions: { ...context.versions }, version_applicability: { ...version_applicability }, confirmation_type: confirmation, confirmation_verified: true });
  return { context, request };
}
function checkError(value, code) {
  assert.equal(value.decision, "ERROR");
  if (code) assert.equal(value.code, code);
  assert.equal(value.execution_allowed, false);
  assert.equal(value.starts_new_risk_check, false);
}
function checkDenied(value, code) {
  assert.equal(value.decision, "DENY");
  if (code) assert.equal(value.code, code);
  assert.equal(value.execution_allowed, false);
  assert.equal(value.starts_new_risk_check, false);
  assert.equal(value.preserve_prior_risk_records, true);
  assert.equal(Object.hasOwn(value, "risk_engine_ran"), false);
}

test("private read permits only its exact server-verified resource grant", () => {
  const { context, request } = fixture();
  const before = structuredClone(context);
  const result = authorizeCapability(context, request);
  assert.equal(result.decision, "ALLOW");
  assert.equal(result.execution_allowed, false);
  assert.deepEqual(context, before);
  assert.equal(Object.isFrozen(result), true);
});

test("a registered public resource is readable without private identity", () => {
  const request = { capability: "public.read", resource_id: "policy-help", purpose: "HELP", audience: "public-help", environment: "TEAM_SYNTHETIC" };
  const context = { environment: request.environment, now, public_resources: [{ resource_id: request.resource_id, purpose: request.purpose, audience: request.audience, environment: request.environment, versions: { tool_registry_version: "synthetic-registry-v1", source_version: "synthetic-policy-v1" } }] };
  assert.equal(authorizeCapability(context, request).decision, "ALLOW");
  checkDenied(authorizeCapability(context, { ...request, resource_id: "private-report" }), "PUBLIC_RESOURCE_NOT_REGISTERED");
});

test("public registry absence is an error rather than inferred public access", () => {
  const { context, request } = fixture("public.read");
  const result = authorizeCapability(context, request);
  assert.equal(result.decision, "ERROR");
  assert.equal(result.code, "PUBLIC_RESOURCE_REGISTRY_UNAVAILABLE");
});

test("client-supplied role, identity, approval or grants cannot upgrade a request", () => {
  for (const control of [{ role: "admin" }, { subject_id: "synthetic-user-1" }, { approved: true }, { grants: ["*"] }, { risk_decision: "ALLOW" }, { version_applicability: { constraints_version: false } }, { model_recipients: [] }]) {
    const { context, request } = fixture();
    checkDenied(authorizeCapability(context, { ...request, ...control }), "UNTRUSTED_CONTROL_FIELD");
  }
});

test("unknown capabilities and an L3 label never inherit read permission", () => {
  const { context, request } = fixture();
  checkDenied(authorizeCapability(context, { ...request, capability: "L3" }), "ACTION_SCOPE_DENIED");
  checkDenied(authorizeCapability(context, { ...request, capability: "financial_data.*" }), "ACTION_SCOPE_DENIED");
});

test("cross-user or guessed resource IDs are rejected before returning data", () => {
  const { context, request } = fixture();
  checkDenied(authorizeCapability({ ...context, resource_owner: "synthetic-user-2" }, request), "SUBJECT_OR_RESOURCE_MISMATCH");
  checkDenied(authorizeCapability(context, { ...request, resource_id: "synthetic-account-2" }), "SUBJECT_OR_RESOURCE_MISMATCH");
});

test("service identity is not an end-user session or vice versa", () => {
  const { context, request } = fixture();
  checkDenied(authorizeCapability({ ...context, session_verified: false }, request), "SUBJECT_AUTHENTICATION_REQUIRED");
  checkDenied(authorizeCapability({ ...context, service_verified: false }, request), "SERVICE_AUTH_REQUIRED");
});

test("an actor scope and a user grant must both cover the exact action", () => {
  const { context, request } = fixture();
  checkDenied(authorizeCapability({ ...context, actor_capabilities: ["analysis.run"] }, request), "ACTOR_SCOPE_DENIED");
  checkDenied(authorizeCapability({ ...context, grants: [] }, request), "ACTION_SCOPE_DENIED");
});

test("the capability actor allowlist rejects maintainers despite an otherwise valid owner grant", () => {
  for (const actor_type of ["MAINTAINER", "SCOPED_AGENT", "AUTHENTICATED_FINANCE_RECOVERY_ACTOR", "AUTHENTICATED_GATEWAY_RECOVERY_ACTOR"]) {
    const { context, request } = fixture(); context.actor_type = actor_type;
    checkDenied(authorizeCapability(context, request), "ACTOR_TYPE_DENIED");
  }
});

test("each registered private-read actor remains subject to the precise valid grant", () => {
  for (const actor_type of ["VERIFIED_RESOURCE_OWNER", "AUTHENTICATED_SCOPED_SERVICE_ACTOR"]) {
    const { context, request } = fixture(); context.actor_type = actor_type;
    assert.equal(authorizeCapability(context, request).decision, "ALLOW");
    context.grants = [];
    checkDenied(authorizeCapability(context, request), "ACTION_SCOPE_DENIED");
  }
});

test("purpose, audience and environment do not widen automatically", () => {
  const { context, request } = fixture();
  for (const changed of [{ purpose: "EXPORT_ALL" }, { audience: "another-model" }]) checkDenied(authorizeCapability(context, { ...request, ...changed }), "ACTION_SCOPE_DENIED");
  checkDenied(authorizeCapability(context, { ...request, environment: "PRODUCTION" }), "ENVIRONMENT_SCOPE_MISMATCH");
});

test("expired, revoked and future grants remain denied at the exact boundary", () => {
  for (const patch of [{ expires_at: now }, { revoked: true }, { issued_at: "2026-10-29T12:00:01+08:00" }]) {
    const { context, request } = fixture();
    Object.assign(context.grants[0], patch);
    checkDenied(authorizeCapability(context, request), "GRANT_NOT_VALID");
  }
});

test("changed version dependencies invalidate prior consent and missing ones are errors", () => {
  const { context, request } = fixture();
  context.versions.data_version = "v2";
  checkDenied(authorizeCapability(context, request), "CONTEXT_VERSION_CHANGED");
  delete context.versions.data_version;
  checkError(authorizeCapability(context, request), "REQUIRED_VERSION_MISSING");
});

test("separate partial grants cannot be unioned into an authorization", () => {
  const { context, request } = fixture();
  context.grants[0].purpose = "OTHER_PURPOSE";
  context.grants.push({ ...context.grants[0], grant_id: "grant-2", purpose: request.purpose, audience: "other-audience" });
  checkDenied(authorizeCapability(context, request), "ACTION_SCOPE_DENIED");
});

test("model sending needs independent confirmed consent and field scope", () => {
  const { context, request } = fixture("model_context.send");
  request.fields = ["cash", "purposes"];
  context.grants[0].fields = ["cash", "purposes"];
  assert.equal(authorizeCapability(context, request).decision, "ALLOW");
  checkDenied(authorizeCapability(context, { ...request, fields: ["cash", "income"] }), "DATA_FIELDS_SCOPE_DENIED");
  const omitted = { ...request }; delete omitted.fields;
  checkDenied(authorizeCapability(context, omitted), "MODEL_FIELDS_REQUIRED");
  context.grants[0].confirmation_type = "DATA_ACCESS_GRANT";
  checkDenied(authorizeCapability(context, request), "CONFIRMATION_SCOPE_REQUIRED");
});

test("an unconfirmed or mismatched confirmation cannot be accepted", () => {
  const { context, request } = fixture("analysis.run");
  context.grants[0].confirmation_verified = false;
  checkDenied(authorizeCapability(context, request), "CONFIRMATION_SCOPE_REQUIRED");
});

test("unimplemented independent writes and exports remain closed", () => {
  for (const capability of ["memory.confirm_write", "memory.revoke", "constraints.confirm_update", "profile.confirm_write", "data.export", "data.delete", "audit.export", "policy.publish", "deployment.manage"]) {
    const { context, request } = fixture(capability);
    checkDenied(authorizeCapability(context, request), "CAPABILITY_NOT_AVAILABLE");
  }
});

test("full declared grants cannot enable L3 or real financial operations", () => {
  for (const capability of ["paper.reserve", "paper.commit"]) {
    const { context, request } = fixture(capability);
    checkDenied(authorizeCapability(context, request), "PAPER_GATEWAY_NOT_CONNECTED");
  }
  for (const capability of ["real_trade.buy", "real_trade.transfer", "real_trade.*"]) {
    const { context, request } = fixture(capability);
    checkDenied(authorizeCapability(context, request), "REAL_EXECUTION_DISABLED");
  }
});

test("trusted read-only reconciliation is limited to the original execution", () => {
  const { context, request } = fixture("execution.reconcile");
  context.actor_type = "AUTHENTICATED_FINANCE_RECOVERY_ACTOR";
  context.session_verified = false;
  context.recovery = { verified: true, original_subject_id: context.subject_id, original_resource_id: request.resource_id, original_task_id: "original-task", original_execution_id: "original-execution", original_proposal_sha256: "a".repeat(64), read_only: true };
  context.grants[0].confirmation_type = "TRUSTED_RECOVERY_AUTHORITY";
  const result = authorizeCapability(context, request);
  assert.equal(result.decision, "ALLOW");
  assert.equal(result.read_only, true);
  assert.equal(result.execution_allowed, false);
  context.recovery.original_subject_id = "another-user";
  checkDenied(authorizeCapability(context, request), "RECOVERY_SCOPE_DENIED");
});

test("ordinary owner reconciliation still requires the current owner session", () => {
  const { context, request } = fixture("execution.reconcile");
  assert.equal(authorizeCapability(context, request).decision, "ALLOW");
  checkDenied(authorizeCapability({ ...context, session_verified: false }, request), "SUBJECT_AUTHENTICATION_REQUIRED");
});

test("recovery actor cannot convert cleanup authority into investment or data access", () => {
  const { context, request } = fixture();
  context.actor_type = "AUTHENTICATED_FINANCE_RECOVERY_ACTOR";
  checkDenied(authorizeCapability(context, request), "ACTOR_TYPE_DENIED");
  const release = fixture("paper.release");
  checkDenied(authorizeCapability(release.context, release.request), "PAPER_RECOVERY_BACKEND_NOT_CONNECTED");
});

test("missing grant validity, conflicting grant IDs and validation failures fail closed", () => {
  for (const mutate of [
    context => { delete context.grants[0].revoked; },
    context => { context.grants.push({ ...context.grants[0] }); },
    context => { context.versions = {}; },
    context => { context.validation_status = "UNAVAILABLE"; },
    context => { context.now = "2026-02-31T12:00:00Z"; }
  ]) {
    const { context, request } = fixture(); mutate(context);
    const result = authorizeCapability(context, request);
    assert.equal(result.decision, "ERROR");
    assert.equal(result.execution_allowed, false);
  }
});

test("accessors and hostile prototypes cannot be treated as authorization data", () => {
  let reads = 0;
  const { context, request } = fixture();
  const malicious = { ...request };
  Object.defineProperty(malicious, "role", { get() { reads += 1; return "admin"; } });
  checkDenied(authorizeCapability(context, malicious), "UNTRUSTED_CONTROL_FIELD");
  assert.equal(reads, 0);
  const inherited = Object.create({ session_verified: true });
  assert.equal(authorizeCapability(inherited, request).decision, "ERROR");
});

test("permission results do not expose private IDs, grants or change historical risk", () => {
  const { context, request } = fixture();
  const original = { risk_decision: "ALLOW", audit_id: "original-private-audit" };
  const result = authorizeCapability(context, { ...request, resource_id: "other-account" });
  checkDenied(result);
  for (const text of [context.subject_id, request.resource_id, context.grants[0].grant_id, original.audit_id]) assert.equal(JSON.stringify(result).includes(text), false);
  assert.deepEqual(original, { risk_decision: "ALLOW", audit_id: "original-private-audit" });
});

test("v1.1 retains the result contract while identifying the hardened policy", () => {
  const { context, request } = fixture();
  const result = authorizeCapability(context, request);
  assert.equal(result.policy_version, "permission-policy.v1.1");
  assert.equal(result.permission_result_version, "unified-permission-result.v1");
});

test("all currently evaluatable private capabilities require their actual matrix versions", () => {
  for (const capability of ["financial_data.read", "model_context.send", "analysis.run", "memory.read", "proposal.compare", "report.save", "audit.read", "execution.reconcile"]) {
    const { context, request } = fixture(capability);
    assert.equal(authorizeCapability(context, request).decision, "ALLOW", capability);
    context.versions = { foo: "v1" }; context.grants[0].versions = { foo: "v1" };
    checkError(authorizeCapability(context, request), "REQUIRED_VERSION_MISSING");
  }
});

test("each mandatory context and grant dependency must be present", () => {
  for (const capability of ["financial_data.read", "model_context.send", "analysis.run", "memory.read", "proposal.compare", "report.save", "audit.read", "execution.reconcile"]) {
    const expected = Object.keys(fixture(capability).context.versions);
    for (const key of expected) {
      const missingContext = fixture(capability); delete missingContext.context.versions[key];
      checkError(authorizeCapability(missingContext.context, missingContext.request), "REQUIRED_VERSION_MISSING");
      const missingGrant = fixture(capability); delete missingGrant.context.grants[0].versions[key];
      checkError(authorizeCapability(missingGrant.context, missingGrant.request), "REQUIRED_GRANT_VERSION_MISSING");
    }
  }
});

test("matching additional version dependencies are retained without substituting required keys", () => {
  const { context, request } = fixture();
  context.versions.extra_source_revision = "extra-v1";
  context.grants[0].versions.extra_source_revision = "extra-v1";
  assert.equal(authorizeCapability(context, request).decision, "ALLOW");
  context.versions.extra_source_revision = "extra-v2";
  checkDenied(authorizeCapability(context, request), "CONTEXT_VERSION_CHANGED");
});

test("conditional dependencies need explicit trusted applicability even when not used", () => {
  for (const capability of ["financial_data.read", "analysis.run", "proposal.compare"]) {
    const { context, request } = fixture(capability);
    assert.equal(authorizeCapability(context, request).decision, "ALLOW");
    delete context.version_applicability;
    checkError(authorizeCapability(context, request), "VERSION_APPLICABILITY_REQUIRED");
  }
});

test("an applicable account or constraints version is mandatory in context and grant", () => {
  for (const key of ["account_version", "constraints_version"]) {
    const { context, request } = fixture();
    context.version_applicability[key] = true;
    context.grants[0].version_applicability[key] = true;
    checkError(authorizeCapability(context, request), "REQUIRED_VERSION_MISSING");
    context.versions[key] = "bound-v1";
    checkError(authorizeCapability(context, request), "REQUIRED_GRANT_VERSION_MISSING");
    context.grants[0].versions[key] = "bound-v1";
    assert.equal(authorizeCapability(context, request).decision, "ALLOW");
    context.versions[key] = "bound-v2";
    checkDenied(authorizeCapability(context, request), "CONTEXT_VERSION_CHANGED");
  }
});

test("changed conditional applicability cannot reuse a grant with the same version values", () => {
  const { context, request } = fixture();
  context.versions.constraints_version = "constraints-v1";
  context.grants[0].versions.constraints_version = "constraints-v1";
  assert.equal(authorizeCapability(context, request).decision, "ALLOW");
  context.version_applicability.constraints_version = true;
  checkDenied(authorizeCapability(context, request), "CONTEXT_VERSION_CHANGED");
  delete context.grants[0].version_applicability;
  checkError(authorizeCapability(context, request), "GRANT_VERSION_APPLICABILITY_REQUIRED");
});

test("applicability rejects unknown flags, non-booleans and accessors without invoking them", () => {
  for (const value of [{ constraints_version: "false" }, { guess_version: false }, Object.create({ account_version: true })]) {
    const { context, request } = fixture(); context.version_applicability = value;
    checkError(authorizeCapability(context, request), "VERSION_APPLICABILITY_REQUIRED");
  }
  let reads = 0;
  const value = {};
  Object.defineProperty(value, "account_version", { get() { reads++; return true; } });
  const { context, request } = fixture(); context.version_applicability = value;
  checkError(authorizeCapability(context, request), "VERSION_APPLICABILITY_REQUIRED");
  assert.equal(reads, 0);
});

test("a model send cannot omit both field scopes or request an empty field list", () => {
  for (const empty of [undefined, []]) {
    const { context, request } = fixture("model_context.send");
    if (empty === undefined) { delete request.fields; delete context.grants[0].fields; }
    else { request.fields = []; context.grants[0].fields = []; }
    checkDenied(authorizeCapability(context, request), "MODEL_FIELDS_REQUIRED");
  }
});

test("a model send requires a nonempty server-confirmed field grant", () => {
  for (const empty of [undefined, []]) {
    const { context, request } = fixture("model_context.send");
    if (empty === undefined) delete context.grants[0].fields;
    else context.grants[0].fields = [];
    checkError(authorizeCapability(context, request), "MODEL_FIELD_GRANT_REQUIRED");
  }
});

test("selected model fields may narrow the confirmed scope but may not widen it", () => {
  const { context, request } = fixture("model_context.send");
  request.fields = ["cash"];
  assert.equal(authorizeCapability(context, request).decision, "ALLOW");
  request.fields = ["cash", "bank_password"];
  checkDenied(authorizeCapability(context, request), "DATA_FIELDS_SCOPE_DENIED");
});

test("model recipients require a complete unambiguous trusted registry", () => {
  for (const change of [
    context => { delete context.model_recipients; },
    context => { context.model_recipients = []; },
    context => { delete context.model_recipients[0].recipient_version; },
    context => { context.model_recipients.push({ ...context.model_recipients[0] }); },
    context => { context.model_recipients[0].url = "https://unregistered.invalid"; }
  ]) {
    const { context, request } = fixture("model_context.send"); change(context);
    checkError(authorizeCapability(context, request), "MODEL_RECIPIENT_REGISTRY_UNAVAILABLE");
  }
});

test("a matching grant cannot authorize an unregistered model recipient or environment", () => {
  for (const change of [
    (context, request) => { request.audience = "unregistered-model"; context.grants[0].audience = request.audience; },
    context => { context.model_recipients[0].environment = "PRODUCTION"; }
  ]) {
    const { context, request } = fixture("model_context.send"); change(context, request);
    checkDenied(authorizeCapability(context, request), "MODEL_RECIPIENT_NOT_REGISTERED");
  }
});

test("recipient changes invalidate the old send grant and need a newly bound grant", () => {
  const { context, request } = fixture("model_context.send");
  context.model_recipients[0].recipient_version = "recipient-v2";
  checkDenied(authorizeCapability(context, request), "MODEL_RECIPIENT_VERSION_CHANGED");
  context.versions.model_recipient_version = "recipient-v2";
  checkDenied(authorizeCapability(context, request), "CONTEXT_VERSION_CHANGED");
  context.grants[0].versions.model_recipient_version = "recipient-v2";
  assert.equal(authorizeCapability(context, request).decision, "ALLOW");
});

test("public resource versions cannot be missing, guessed, or ambiguously registered", () => {
  const request = { capability: "public.read", resource_id: "policy-help", purpose: "HELP", audience: "public-help", environment: "TEAM_SYNTHETIC" };
  const fresh = () => ({ environment: request.environment, now, public_resources: [{ resource_id: request.resource_id, purpose: request.purpose, audience: request.audience, environment: request.environment, versions: { tool_registry_version: "registry-v1", source_version: "source-v1" } }] });
  for (const change of [
    context => { delete context.public_resources[0].versions; },
    context => { context.public_resources[0].versions = { foo: "v1" }; },
    context => { delete context.public_resources[0].versions.source_version; },
    context => { context.public_resources.push(structuredClone(context.public_resources[0])); }
  ]) { const context = fresh(); change(context); checkError(authorizeCapability(context, request), "PUBLIC_RESOURCE_REGISTRY_UNAVAILABLE"); }
  checkDenied(authorizeCapability(fresh(), { ...request, fields: ["extra-private-field"] }), "DATA_FIELDS_SCOPE_DENIED");
});

test("trusted recovery's recorded proposal must match its granted version", () => {
  const { context, request } = fixture("execution.reconcile");
  context.actor_type = "AUTHENTICATED_FINANCE_RECOVERY_ACTOR";
  context.session_verified = false;
  context.recovery = { verified: true, original_subject_id: context.subject_id, original_resource_id: request.resource_id, original_task_id: "original-task", original_execution_id: "original-execution", original_proposal_sha256: "b".repeat(64), read_only: true };
  context.grants[0].confirmation_type = "TRUSTED_RECOVERY_AUTHORITY";
  checkDenied(authorizeCapability(context, request), "RECOVERY_SCOPE_DENIED");
});

test("reconciliation admits only the matrix owner and two narrow trusted recovery actors", () => {
  for (const actor_type of ["MAINTAINER", "SCOPED_AGENT", "AUTHENTICATED_SCOPED_SERVICE_ACTOR"]) {
    const { context, request } = fixture("execution.reconcile"); context.actor_type = actor_type;
    checkDenied(authorizeCapability(context, request), "ACTOR_TYPE_DENIED");
  }
  for (const actor_type of ["AUTHENTICATED_FINANCE_RECOVERY_ACTOR", "AUTHENTICATED_GATEWAY_RECOVERY_ACTOR"]) {
    const { context, request } = fixture("execution.reconcile");
    context.actor_type = actor_type; context.session_verified = false;
    context.recovery = { verified: true, original_subject_id: context.subject_id, original_resource_id: request.resource_id, original_task_id: "original-task", original_execution_id: "original-execution", original_proposal_sha256: context.versions.original_proposal_sha256, read_only: true };
    context.grants[0].confirmation_type = "TRUSTED_RECOVERY_AUTHORITY";
    const value = authorizeCapability(context, request);
    assert.equal(value.decision, "ALLOW"); assert.equal(value.read_only, true); assert.equal(value.execution_allowed, false);
  }
});
