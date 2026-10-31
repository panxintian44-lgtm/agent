"use strict";

const { ReviewError } = require("./model-review");

const OWNER_FIELDS = Object.freeze({
  risk: { actor: "reviewer", url: "RISK_SERVICE_URL", secret: ["RISK_SERVICE_HMAC_SECRET", "RISK_HMAC_SECRET"], signature: "X-Risk-Signature" },
  approval: { actor: "approver", url: "APPROVAL_SERVICE_URL", secret: ["APPROVAL_SERVICE_HMAC_SECRET", "APPROVAL_HMAC_SECRET"], signature: "X-Approval-Signature" }
});
const ADAPTER_VERSION = "owner-bridge.v1";
const MAX_RESPONSE_BYTES = 4000;

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function webCrypto() {
  if (globalThis.crypto?.subtle) return globalThis.crypto;
  return require("node:crypto").webcrypto;
}

async function hmacHex(value, secret) {
  const crypto = webCrypto();
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(typeof value === "string" ? value : canonicalJson(value)));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

async function signatureFor(value, secret) {
  return "sha256=" + await hmacHex(value, secret);
}

function headerValue(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === "function") return headers.get(name);
  return headers[name.toLowerCase()] || headers[name] || null;
}

function envValue(env, key) {
  const value = env?.[key];
  return typeof value === "string" ? value.trim() : value ? String(value).trim() : "";
}

function ownerSecret(owner, env) {
  return (OWNER_FIELDS[owner]?.secret || []).map(key => envValue(env, key)).find(Boolean) || "";
}

function ownerUrl(owner, env) {
  return envValue(env, OWNER_FIELDS[owner]?.url);
}

function booleanSetting(env, key) {
  const value = envValue(env, key).toLowerCase();
  return { enabled: value === "true", valid: ["", "true", "false"].includes(value) };
}

// Expose configuration readiness, never credential values or end-user identity claims.
function riskIdentityStatus(env) {
  const actors = booleanSetting(env, "REQUIRE_TRUSTED_ACTORS");
  const reviewerFlag = booleanSetting(env, "REQUIRE_RISK_REVIEWER");
  const reviewer = envValue(env, "RISK_REVIEWER_ID");
  const configured = typeof env?.RISK_REVIEWER_ID === "string" && reviewer.length > 0 && reviewer.length <= 500;
  const required = actors.enabled || reviewerFlag.enabled || Boolean(reviewer);
  const flagsValid = actors.valid && reviewerFlag.valid;
  const signatureConfigured = Boolean(ownerSecret("risk", env));
  return {
    fixed_reviewer_required: required,
    fixed_reviewer_configured: configured,
    strict_settings_valid: flagsValid,
    callback_identity_ready: flagsValid && configured && signatureConfigured
  };
}

function bridgeError(code, message, { statusCode = 503, retryable = false, stage = "OWNER_INTEGRATION", recovery = "检查对应 Owner 的地址、签名密钥和联调状态。", details = null } = {}) {
  return new ReviewError(code, message, { statusCode, retryable, stage, recovery, details });
}

async function verifyOwnerRequest({ owner, body, headers, env }) {
  const definition = OWNER_FIELDS[owner];
  if (!definition) throw bridgeError("UNKNOWN_OWNER", "未定义的 Owner 类型。", { statusCode: 500 });
  const secret = ownerSecret(owner, env);
  const actor = typeof body?.[definition.actor] === "string" ? body[definition.actor].trim() : null;
  const actors = booleanSetting(env, "REQUIRE_TRUSTED_ACTORS");
  const riskIdentity = owner === "risk" ? riskIdentityStatus(env) : null;
  if (!actors.valid || riskIdentity && !riskIdentity.strict_settings_valid) {
    throw bridgeError("OWNER_AUTH_CONFIG_INVALID", "身份校验开关不是有效的布尔配置。", {
      recovery: "服务端 REQUIRE_TRUSTED_ACTORS 和 REQUIRE_RISK_REVIEWER 仅允许 true 或 false；不要从请求读取。"
    });
  }
  if (!secret) {
    if (actors.enabled || riskIdentity?.fixed_reviewer_required) {
      throw bridgeError("OWNER_AUTH_NOT_CONFIGURED", `${owner} 的可信身份验证尚未配置。`, { recovery: "配置对应 HMAC secret 后再启用 REQUIRE_TRUSTED_ACTORS。" });
    }
    return { owner, actor, mode: "DEMO_UNVERIFIED", verified: false, signature_header: definition.signature,
      identity_scope: "UNVERIFIED", fixed_actor_verified: false, end_user_identity_verified: false };
  }
  const supplied = headerValue(headers, definition.signature) || "";
  if (!supplied) throw bridgeError("OWNER_AUTH_REQUIRED", `${owner} 回写缺少签名。`, { statusCode: 401, stage: "AUTHENTICATION", recovery: `使用 ${definition.signature} 携带 sha256 HMAC 签名后重试。` });
  const expected = await signatureFor(body, secret);
  if (supplied.trim().toLowerCase() !== expected) {
    throw bridgeError("OWNER_AUTH_INVALID", `${owner} 回写签名无效。`, { statusCode: 401, stage: "AUTHENTICATION", recovery: "重新读取当前 Handoff，使用相同请求正文生成签名。" });
  }
  if (riskIdentity?.fixed_reviewer_required && !riskIdentity.fixed_reviewer_configured) {
    throw bridgeError("OWNER_IDENTITY_NOT_CONFIGURED", "Risk 的固定审核身份尚未正确配置。", {
      recovery: "在双方服务端配置相同且不超过 500 字符的 RISK_REVIEWER_ID；不能从用户表单读取。"
    });
  }
  if (riskIdentity?.fixed_reviewer_configured && actor !== envValue(env, "RISK_REVIEWER_ID")) {
    throw bridgeError("OWNER_ACTOR_MISMATCH", "Risk 审核身份与服务端配置不一致。", {
      statusCode: 403, stage: "AUTHENTICATION", recovery: "使用服务端配置的 Risk 身份重新签署；不要修改原任务。"
    });
  }
  return { owner, actor, mode: "HMAC_SHA256", verified: true, signature_header: definition.signature,
    identity_scope: "SERVICE", fixed_actor_verified: Boolean(riskIdentity?.fixed_reviewer_configured), end_user_identity_verified: false };
}

function buildRiskDispatchEnvelope(handoff) {
  return {
    adapter_version: ADAPTER_VERSION,
    contract_version: "risk-handoff.v1",
    operation: "RISK_HANDOFF",
    sent_at: new Date().toISOString(),
    trace: clone(handoff.trace),
    handoff: clone(handoff)
  };
}

async function postSignedJson({ owner, url, secret, body, fetchImpl = globalThis.fetch, timeoutMs = 12000, allowInsecure = false }) {
  if (!url || !secret) throw bridgeError(`${owner.toUpperCase()}_OWNER_NOT_CONFIGURED`, `${owner} 服务地址或签名密钥尚未配置。`, { recovery: `配置 ${owner.toUpperCase()}_SERVICE_URL 和对应 HMAC secret 后再联调。` });
  let parsed;
  try { parsed = new URL(url); } catch { throw bridgeError("OWNER_URL_INVALID", `${owner} 服务地址不是有效 URL。`, { statusCode: 500, recovery: "使用完整的 HTTPS 服务地址。" }); }
  if (parsed.username || parsed.password || parsed.hash) throw bridgeError("OWNER_URL_INVALID", "Owner URL cannot contain embedded credentials or a fragment.", { statusCode: 500 });
  if (parsed.protocol !== "https:" && !allowInsecure) throw bridgeError("OWNER_URL_INSECURE", `${owner} 服务地址必须使用 HTTPS。`, { statusCode: 500, recovery: "使用 HTTPS 地址；仅在本地替身测试时显式开启 ALLOW_INSECURE_OWNER_URL=true。" });
  if (typeof fetchImpl !== "function") throw bridgeError("OWNER_HTTP_UNAVAILABLE", "当前运行环境没有可用的 HTTP 客户端。", { statusCode: 503 });
  const bodyText = canonicalJson(body);
  const signature = await signatureFor(bodyText, secret);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, Number(timeoutMs) || 12000));
  let reader;
  let abortListener;
  const aborted = new Promise((_, reject) => {
    abortListener = () => reject(bridgeError("OWNER_SERVICE_UNAVAILABLE", `${owner} 服务响应超时。`, { retryable: true, details: { cause: "TIMEOUT" } }));
    controller.signal.addEventListener("abort", abortListener, { once: true });
  });
  try {
    const response = await Promise.race([fetchImpl(parsed.toString(), {
      method: "POST",
      redirect: "manual",
      headers: {
        "Content-Type": "application/json",
        "X-Core-Agent-Adapter": ADAPTER_VERSION,
        "X-Core-Agent-Contract": "risk-handoff.v1",
        "X-Core-Agent-Signature": signature,
        "X-Core-Agent-Trace": body.trace?.task_id || "unknown"
      },
      body: bodyText,
      signal: controller.signal
    }), aborted]);
    if (response.redirected || response.status >= 300 && response.status < 400) {
      throw bridgeError("OWNER_SERVICE_REJECTED", "Owner redirect was rejected; signed handoffs cannot be forwarded.", { statusCode: 502, details: { upstream_status: response.status } });
    }
    if (!response.ok) throw bridgeError("OWNER_SERVICE_REJECTED", `${owner} 服务拒绝了 Risk Handoff。`, {
      statusCode: 502, retryable: response.status >= 500, details: { upstream_status: response.status } });
    // A header response is not a complete acknowledgement. Keep the deadline active
    // until the body is consumed, cap bytes, and never echo upstream error contents.
    if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get("Content-Type") || "") || !response.body) {
      throw bridgeError("OWNER_SERVICE_REJECTED", "Owner acknowledgement must be JSON.", { statusCode: 502, details: { upstream_status: response.status } });
    }
    reader = response.body.getReader();
    const chunks = []; let size = 0;
    while (true) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      size += value.length;
      if (size > MAX_RESPONSE_BYTES) throw bridgeError("OWNER_SERVICE_REJECTED", "Owner acknowledgement exceeds its size limit.", { statusCode: 502 });
      chunks.push(value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    let responseBody;
    try { responseBody = JSON.parse(new TextDecoder().decode(bytes)); }
    catch { throw bridgeError("OWNER_SERVICE_REJECTED", "Owner acknowledgement contains invalid JSON.", { statusCode: 502 }); }
    if (!responseBody || typeof responseBody !== "object" || Array.isArray(responseBody) || responseBody.accepted === false || responseBody.error) {
      throw bridgeError("OWNER_SERVICE_REJECTED", "Owner did not acknowledge this handoff.", { statusCode: 502, details: { upstream_status: response.status } });
    }
    return { accepted: true, upstream_status: response.status, response: responseBody };
  } catch (error) {
    if (error instanceof ReviewError) throw error;
    throw bridgeError("OWNER_SERVICE_UNAVAILABLE", `${owner} 服务暂时不可达。`, { retryable: true, details: { cause: error.name === "AbortError" ? "TIMEOUT" : "NETWORK_ERROR" } });
  } finally {
    clearTimeout(timer);
    controller.signal.removeEventListener("abort", abortListener);
    if (reader) void reader.cancel().catch(() => {});
  }
}

async function dispatchRiskHandoff(handoff, env, options = {}) {
  const envelope = buildRiskDispatchEnvelope(handoff);
  return postSignedJson({
    owner: "risk",
    url: ownerUrl("risk", env),
    secret: ownerSecret("risk", env),
    body: envelope,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs || envValue(env, "RISK_SERVICE_TIMEOUT_MS") || 12000,
    allowInsecure: envValue(env, "ALLOW_INSECURE_OWNER_URL").toLowerCase() === "true"
  });
}

module.exports = { ADAPTER_VERSION, OWNER_FIELDS, canonicalize, canonicalJson, hmacHex, signatureFor, riskIdentityStatus, verifyOwnerRequest, buildRiskDispatchEnvelope, dispatchRiskHandoff, bridgeError };
