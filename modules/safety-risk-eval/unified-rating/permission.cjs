"use strict";

// This evaluator consumes server-created context only. It does not authenticate a
// browser, verify signatures, issue grants, or perform resource/financial writes.
const matrix = require("../../../docs/safety-risk-eval/unified-rating-v1/permission-matrix.json");
const POLICY_VERSION = "permission-policy.v1.1";
const RESULT_VERSION = "unified-permission-result.v1";
const capabilities = new Map(matrix.capabilities.map(item => [item.id, item]));
const actorTypes = new Set(["VERIFIED_RESOURCE_OWNER", "AUTHENTICATED_SCOPED_SERVICE_ACTOR", "SCOPED_AGENT", "MAINTAINER", "AUTHENTICATED_FINANCE_RECOVERY_ACTOR", "AUTHENTICATED_GATEWAY_RECOVERY_ACTOR"]);
const recoveryActors = new Set(["AUTHENTICATED_FINANCE_RECOVERY_ACTOR", "AUTHENTICATED_GATEWAY_RECOVERY_ACTOR"]);
const requestKeys = ["capability", "resource_id", "purpose", "audience", "environment", "fields"];
const contextKeys = ["session_verified", "subject_id", "actor_id", "actor_type", "service_verified", "actor_capabilities", "resource_id", "resource_owner", "environment", "versions", "version_applicability", "now", "grants", "public_resources", "model_recipients", "validation_status", "recovery"];
const grantKeys = ["grant_id", "subject_id", "actor_id", "capability", "resource_id", "purpose", "audience", "environment", "issued_at", "expires_at", "revoked", "versions", "version_applicability", "confirmation_type", "confirmation_verified", "fields"];
const publicScopeKeys = ["resource_id", "purpose", "audience", "environment"];
const publicKeys = [...publicScopeKeys, "versions"];
const applicabilityKeys = ["account_version", "constraints_version"];
const recipientKeys = ["audience", "environment", "recipient_version"];
const recoveryKeys = ["verified", "original_subject_id", "original_resource_id", "original_task_id", "original_execution_id", "original_proposal_sha256", "read_only"];

function plain(value, allowed) {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || allowed && !allowed.includes(key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), "value")) return false;
  }
  return true;
}

function text(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 500 && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
}

function stringList(value, maximum = 64) {
  return Array.isArray(value) && value.length <= maximum && value.every(text) && new Set(value).size === value.length;
}

function time(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const day = value.slice(0, 10), calendar = new Date(`${day}T00:00:00Z`), parsed = Date.parse(value);
  return Number.isFinite(parsed) && Number.isFinite(calendar.getTime()) && calendar.toISOString().slice(0, 10) === day ? parsed : null;
}

function validVersions(value) {
  if (!plain(value)) return false;
  const keys = Object.keys(value);
  return keys.length > 0 && keys.length <= 24 && keys.every(key => text(key) && (text(value[key]) || Number.isSafeInteger(value[key]) && value[key] >= 0));
}

function versionValue(value) { return text(value) || Number.isSafeInteger(value) && value >= 0; }
function applicability(value) {
  return plain(value, applicabilityKeys) && Object.values(value).every(flag => typeof flag === "boolean");
}

// Matrix suffixes are descriptive requirements, never literal version keys.
// Conditional dependencies are declared by the trusted caller and bound to the
// same scope on the grant; a later condition change invalidates that consent.
function versionRequirements(definition, state) {
  const required = [], conditional = [];
  for (const key of definition.scope.versions) {
    const match = /^(.*)_if_(available|used)$/.exec(key);
    if (!match) required.push(key);
    else {
      conditional.push(match[1]);
      if (state?.[match[1]] === true) required.push(match[1]);
    }
  }
  return { required, conditional };
}

function hasVersions(versions, required) {
  return required.every(key => Object.hasOwn(versions, key) && versionValue(versions[key]) &&
    (!key.endsWith("sha256") || typeof versions[key] === "string" && /^[a-f0-9]{64}$/.test(versions[key])));
}

function sameVersions(left, right) {
  const a = Object.keys(left).sort(), b = Object.keys(right).sort();
  return a.length === b.length && a.every((key, index) => key === b[index] && left[key] === right[key]);
}

function result(decision, code, message, capability = null, extra = {}) {
  return Object.freeze({
    permission_result_version: RESULT_VERSION,
    policy_version: POLICY_VERSION,
    decision, code, message_zh: message, capability,
    event_scope: "THIS_PERMISSION_GATE_CHECK_ONLY",
    starts_new_risk_check: false,
    preserve_prior_risk_records: true,
    permission_only: true,
    execution_allowed: false,
    ...extra
  });
}

function denied(code, message, capability) { return result("DENY", code, message, capability); }
function failed(code, message, capability) { return result("ERROR", code, message, capability); }

function validateGrant(grant) {
  return plain(grant, grantKeys) && ["grant_id", "subject_id", "actor_id", "capability", "resource_id", "purpose", "audience", "environment", "confirmation_type"].every(key => text(grant[key])) &&
    typeof grant.revoked === "boolean" && typeof grant.confirmation_verified === "boolean" && time(grant.issued_at) !== null && time(grant.expires_at) !== null &&
    validVersions(grant.versions) && (grant.fields === undefined || stringList(grant.fields)) &&
    (grant.version_applicability === undefined || applicability(grant.version_applicability));
}

function recoveryBinding(context, request) {
  const recovery = context.recovery;
  return plain(recovery, recoveryKeys) && recovery.verified === true && recovery.read_only === true &&
    recovery.original_subject_id === context.subject_id && recovery.original_resource_id === request.resource_id &&
    text(recovery.original_task_id) && text(recovery.original_execution_id) && typeof recovery.original_proposal_sha256 === "string" && /^[a-f0-9]{64}$/.test(recovery.original_proposal_sha256) &&
    context.versions.original_proposal_sha256 === recovery.original_proposal_sha256;
}

function authorizeCapability(context, request) {
  let capability = null;
  try {
    if (!plain(request, requestKeys)) return denied("UNTRUSTED_CONTROL_FIELD", "请求只能声明动作、资源、用途、接收方和环境，不能提交身份、权限或批准结论。", null);
    if (!text(request.capability)) return denied("ACTION_SCOPE_DENIED", "未识别的操作能力。", null);
    capability = request.capability;
    if (capability === "real_trade.*" || capability.startsWith("real_trade.")) return denied("REAL_EXECUTION_DISABLED", "本版本禁止真实资金操作，任何用户确认或管理员身份都不能开启。", capability);
    const definition = capabilities.get(capability);
    if (!definition) return denied("ACTION_SCOPE_DENIED", "该动作没有登记到权限目录。", capability);
    if (!["resource_id", "purpose", "audience", "environment"].every(key => text(request[key])) || request.fields !== undefined && !stringList(request.fields)) return denied("INVALID_PERMISSION_REQUEST", "操作资源、用途、接收方或环境不完整。", capability);
    if (!plain(context, contextKeys)) return failed("INVALID_SERVER_PERMISSION_CONTEXT", "服务端权限上下文无法验证，相关操作暂停。", capability);
    if (context.validation_status !== undefined && context.validation_status !== "READY") return failed("REQUIRED_CONTROL_UNAVAILABLE", "必要权限服务尚未就绪，相关操作暂停。", capability);
    if (!text(context.environment) || time(context.now) === null) return failed("INVALID_SERVER_PERMISSION_CONTEXT", "服务端环境或校验时间无效。", capability);
    if (context.environment !== request.environment) return denied("ENVIRONMENT_SCOPE_MISMATCH", "授权环境与当前操作环境不一致。", capability);

    if (capability === "public.read") {
      if (!Array.isArray(context.public_resources) || context.public_resources.length > 100 || context.public_resources.some(row => !plain(row, publicKeys) || !publicScopeKeys.every(key => text(row[key])) || !validVersions(row.versions) || !hasVersions(row.versions, definition.scope.versions))) return failed("PUBLIC_RESOURCE_REGISTRY_UNAVAILABLE", "公开资源登记及来源版本无法验证。", capability);
      const ids = context.public_resources.map(row => JSON.stringify(publicScopeKeys.map(key => row[key])));
      if (new Set(ids).size !== ids.length) return failed("PUBLIC_RESOURCE_REGISTRY_UNAVAILABLE", "公开资源登记存在重复或冲突，需要先核对来源版本。", capability);
      if (request.fields !== undefined) return denied("DATA_FIELDS_SCOPE_DENIED", "本公开目录只登记整份公开资源，不接受额外字段范围。", capability);
      const registered = context.public_resources.some(row => publicScopeKeys.every(key => row[key] === request[key]));
      return registered ? result("ALLOW", "PUBLIC_READ_ALLOWED", "允许读取已登记的公开只读资源。", capability) : denied("PUBLIC_RESOURCE_NOT_REGISTERED", "该资源或读取用途未登记为公开只读。", capability);
    }

    if (capability === "paper.reserve" || capability === "paper.commit") return denied("PAPER_GATEWAY_NOT_CONNECTED", "统一本人审批、账本和执行网关尚未联合验收，模拟资金写入保持关闭。", capability);
    if (capability === "paper.release") return denied("PAPER_RECOVERY_BACKEND_NOT_CONNECTED", "资金释放须由可信原任务恢复服务完成，本入口不能写入或创建新的资金动作。", capability);
    if (definition.current_capability.runtime_available === false && capability !== "execution.reconcile") return denied("CAPABILITY_NOT_AVAILABLE", "该独立能力尚未接通受控服务，不能仅凭权限声明执行。", capability);

    if (typeof context.service_verified !== "boolean") return failed("INVALID_SERVER_PERMISSION_CONTEXT", "缺少服务端调用者验证结果。", capability);
    if (!context.service_verified) return denied("SERVICE_AUTH_REQUIRED", "调用服务身份尚未验证。", capability);
    if (!text(context.actor_id) || !actorTypes.has(context.actor_type) || !stringList(context.actor_capabilities)) return failed("INVALID_SERVER_PERMISSION_CONTEXT", "服务端动作范围或调用者上下文无效。", capability);
    if (!stringList(definition.actors) || definition.actors.length === 0) return failed("ACTOR_POLICY_UNAVAILABLE", "该能力允许的调用者类型尚未登记完整。", capability);
    if (!definition.actors.includes(context.actor_type)) return denied("ACTOR_TYPE_DENIED", "当前调用者类型不在该能力允许范围内，身份或授权声明不能扩大权限。", capability);
    if (!context.actor_capabilities.includes(capability)) return denied("ACTOR_SCOPE_DENIED", "调用者未获得该精确动作权限。", capability);
    if (!text(context.subject_id) || !text(context.resource_owner) || !text(context.resource_id)) return failed("RESOURCE_OWNERSHIP_UNAVAILABLE", "资源归属信息不完整。", capability);
    if (context.resource_id !== request.resource_id || context.resource_owner !== context.subject_id) return denied("SUBJECT_OR_RESOURCE_MISMATCH", "当前用户、资源或任务归属不一致。", capability);
    if (!validVersions(context.versions)) return failed("RESOURCE_VERSION_UNAVAILABLE", "资源或授权依赖版本尚未确认。", capability);
    if (context.version_applicability !== undefined && !applicability(context.version_applicability)) return failed("VERSION_APPLICABILITY_REQUIRED", "服务端条件版本适用性记录无法验证。", capability);
    const dependencies = versionRequirements(definition, context.version_applicability);
    if (dependencies.conditional.some(key => typeof context.version_applicability?.[key] !== "boolean")) return failed("VERSION_APPLICABILITY_REQUIRED", "服务端尚未明确哪些条件版本适用于本次动作。", capability);
    if (!hasVersions(context.versions, dependencies.required)) return failed("REQUIRED_VERSION_MISSING", "本次动作所必需的资源、授权或数据版本缺失。", capability);

    if (capability === "model_context.send") {
      if (!Array.isArray(request.fields) || request.fields.length === 0) return denied("MODEL_FIELDS_REQUIRED", "发送给模型前必须明确选中非空资料字段范围。", capability);
      if (!Array.isArray(context.model_recipients) || context.model_recipients.length === 0 || context.model_recipients.length > 64 || context.model_recipients.some(row => !plain(row, recipientKeys) || !text(row.audience) || !text(row.environment) || !versionValue(row.recipient_version))) return failed("MODEL_RECIPIENT_REGISTRY_UNAVAILABLE", "服务端模型接收方登记无法验证。", capability);
      const ids = context.model_recipients.map(row => JSON.stringify([row.audience, row.environment]));
      if (new Set(ids).size !== ids.length) return failed("MODEL_RECIPIENT_REGISTRY_UNAVAILABLE", "服务端模型接收方登记存在重复或冲突。", capability);
      const recipient = context.model_recipients.find(row => row.audience === request.audience && row.environment === request.environment);
      if (!recipient) return denied("MODEL_RECIPIENT_NOT_REGISTERED", "该模型接收方未登记在当前环境允许范围内。", capability);
      if (recipient.recipient_version !== context.versions.model_recipient_version) return denied("MODEL_RECIPIENT_VERSION_CHANGED", "模型接收方版本已变化，需重新核对发送授权。", capability);
    }

    const recoveryActor = capability === "execution.reconcile" && recoveryActors.has(context.actor_type);
    if (recoveryActor) {
      if (!recoveryBinding(context, request)) return denied("RECOVERY_SCOPE_DENIED", "核账权限未绑定原用户、原任务、原方案和原执行记录。", capability);
    } else {
      if (typeof context.session_verified !== "boolean") return failed("INVALID_SERVER_PERMISSION_CONTEXT", "缺少服务端本人会话验证结果。", capability);
      if (!context.session_verified) return denied("SUBJECT_AUTHENTICATION_REQUIRED", "请使用已验证的本人会话访问该资源。", capability);
      if (recoveryActors.has(context.actor_type)) return denied("RECOVERY_SCOPE_DENIED", "恢复服务只能核查已绑定的原执行记录。", capability);
    }

    if (!Array.isArray(context.grants) || context.grants.length > 64 || context.grants.some(grant => !validateGrant(grant))) return failed("GRANT_CONTEXT_INVALID", "服务端授权记录不完整，不能推断授权有效。", capability);
    if (new Set(context.grants.map(grant => grant.grant_id)).size !== context.grants.length) return failed("GRANT_CONTEXT_INVALID", "授权记录编号存在冲突，需要先核查。", capability);
    const matching = context.grants.filter(grant => ["subject_id", "actor_id"].every(key => grant[key] === context[key]) &&
      ["capability", "resource_id", "purpose", "audience", "environment"].every(key => grant[key] === request[key]));
    if (matching.length === 0) return denied("ACTION_SCOPE_DENIED", "没有覆盖本次资源、用途、接收方和动作的有效授权。", capability);
    const now = time(context.now);
    const current = matching.filter(grant => grant.revoked === false && time(grant.issued_at) <= now && now < time(grant.expires_at));
    if (current.length === 0) return denied("GRANT_NOT_VALID", "对应授权已撤回、过期或尚未生效。", capability);
    if (current.some(grant => !hasVersions(grant.versions, dependencies.required))) return failed("REQUIRED_GRANT_VERSION_MISSING", "对应授权缺少该动作必需的版本，不能推断确认仍然有效。", capability);
    if (dependencies.conditional.length && current.some(grant => dependencies.conditional.some(key => typeof grant.version_applicability?.[key] !== "boolean"))) return failed("GRANT_VERSION_APPLICABILITY_REQUIRED", "对应授权未记录条件版本的适用范围。", capability);
    const versioned = current.filter(grant => sameVersions(grant.versions, context.versions) && dependencies.conditional.every(key => grant.version_applicability[key] === context.version_applicability[key]));
    if (versioned.length === 0) return denied("CONTEXT_VERSION_CHANGED", "资料、用途或授权依赖版本已变化，需要重新确认。", capability);
    const confirmation = recoveryActor ? "TRUSTED_RECOVERY_AUTHORITY" : capability === "execution.reconcile" ? "OWNER_EXECUTION_READ_GRANT" : definition.confirmation_type;
    const confirmed = versioned.filter(grant => grant.confirmation_verified === true && grant.confirmation_type === confirmation);
    if (confirmed.length === 0) return denied("CONFIRMATION_SCOPE_REQUIRED", "尚未取得与本次动作相符的明确授权确认。", capability);
    if (capability === "model_context.send" && confirmed.some(grant => !Array.isArray(grant.fields) || grant.fields.length === 0)) return failed("MODEL_FIELD_GRANT_REQUIRED", "服务端模型发送授权未记录明确的非空字段范围。", capability);
    const selected = confirmed.filter(grant => grant.fields === undefined ? request.fields === undefined : Array.isArray(request.fields) && request.fields.every(field => grant.fields.includes(field)));
    if (selected.length === 0) return denied("DATA_FIELDS_SCOPE_DENIED", "请求字段超出已确认范围，不能自动扩大资料访问或发送范围。", capability);
    return result("ALLOW", recoveryActor ? "TRUSTED_READ_ONLY_RECOVERY_ALLOWED" : "SCOPED_PERMISSION_ALLOWED", recoveryActor ? "允许核查原执行结果，不允许重试资金写入。" : "本次精确动作符合已验证的资源和授权范围。", capability, { read_only: definition.side_effect === "NONE", resource_service_still_required: true });
  } catch {
    return failed("PERMISSION_CHECK_FAILED", "权限检查未能完成，相关操作保持暂停。", capability);
  }
}

module.exports = { authorizeCapability, POLICY_VERSION, RESULT_VERSION };
