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

function flagValue(env, key) {
  if (env?.[key] === undefined || env?.[key] === null) return false;
  if (typeof env[key] === "boolean") return env[key];
  if (typeof env[key] !== "string" || !["true", "false"].includes(env[key].trim().toLowerCase())) {
    throw bridgeError("OWNER_CONFIG_INVALID", `${key} must be exactly true or false.`, {
      statusCode: 503, stage: "CONFIGURATION", recovery: `Set ${key}=true or ${key}=false on the server.`
    });
  }
  return env[key].trim().toLowerCase() === "true";
}

function ownerUrl(owner, env) {
  return envValue(env, OWNER_FIELDS[owner]?.url);
}

function bridgeError(code, message, { statusCode = 503, retryable = false, stage = "OWNER_INTEGRATION", recovery = "检查对应 Owner 的地址、签名密钥和联调状态。", details = null } = {}) {
  return new ReviewError(code, message, { statusCode, retryable, stage, recovery, details });
}

function validActor(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 200 && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
}

function fixedRiskReviewer(env) {
  const configured = env?.RISK_REVIEWER_ID;
  if (configured === undefined || configured === null || configured === "") return "";
  if (!validActor(configured)) {
    throw bridgeError("OWNER_CONFIG_INVALID", "RISK_REVIEWER_ID must be a non-empty server-side identity without surrounding whitespace or control characters.", {
      statusCode: 503, stage: "CONFIGURATION", recovery: "Set one fixed RISK_REVIEWER_ID on both services; do not read it from user input."
    });
  }
  return configured;
}

function resolveOwnerConfig(owner, env) {
  const definition = OWNER_FIELDS[owner];
  if (!definition) throw bridgeError("UNKNOWN_OWNER", "未定义的 Owner 类型。", { statusCode: 500 });
  const requireTrustedActors = flagValue(env, "REQUIRE_TRUSTED_ACTORS");
  const requireRiskReviewer = owner === "risk" ? flagValue(env, "REQUIRE_RISK_REVIEWER") : false;
  const primarySecret = envValue(env, definition.secret[0]);
  const compatibilitySecret = envValue(env, definition.secret[1]);
  const primaryRequired = owner === "risk" && (requireTrustedActors || requireRiskReviewer);
  if (primaryRequired && !primarySecret && compatibilitySecret) {
    throw bridgeError("OWNER_CONFIG_INVALID", "Risk strict mode requires RISK_SERVICE_HMAC_SECRET; the compatibility secret name is not accepted.", {
      statusCode: 503, stage: "CONFIGURATION", recovery: "Configure RISK_SERVICE_HMAC_SECRET on the server and keep its value private."
    });
  }
  const secret = primarySecret || compatibilitySecret;
  const reviewer = owner === "risk" ? fixedRiskReviewer(env) : "";
  if (owner === "risk" && requireRiskReviewer && !reviewer) {
    throw bridgeError("OWNER_REVIEWER_NOT_CONFIGURED", "Risk strict mode requires RISK_REVIEWER_ID.", {
      statusCode: 503, stage: "CONFIGURATION", recovery: "Configure the same fixed RISK_REVIEWER_ID on both services."
    });
  }
  return { owner, secret, secret_name: primarySecret ? definition.secret[0] : (compatibilitySecret ? definition.secret[1] : null),
    primary_secret_configured: Boolean(primarySecret), compatibility_secret_configured: Boolean(compatibilitySecret),
    require_trusted_actors: requireTrustedActors, require_risk_reviewer: requireRiskReviewer,
    reviewer, secret_required: primaryRequired };
}

function ownerConfigurationStatus(owner, env) {
  try {
    const config = resolveOwnerConfig(owner, env);
    return { owner, secret_configured: Boolean(config.secret), secret_name: config.secret_name,
      primary_secret_configured: config.primary_secret_configured,
      compatibility_secret_configured: config.compatibility_secret_configured,
      require_trusted_actors: config.require_trusted_actors, require_risk_reviewer: config.require_risk_reviewer,
      reviewer_configured: Boolean(config.reviewer), configuration_error: null };
  } catch (error) {
    const definition = OWNER_FIELDS[owner];
    const primary = definition ? envValue(env, definition.secret[0]) : "";
    const compatibility = definition ? envValue(env, definition.secret[1]) : "";
    let trusted = false, reviewerStrict = false;
    try { trusted = flagValue(env, "REQUIRE_TRUSTED_ACTORS"); } catch { /* report invalid below */ }
    try { reviewerStrict = owner === "risk" && flagValue(env, "REQUIRE_RISK_REVIEWER"); } catch { /* report invalid below */ }
    return { owner, secret_configured: Boolean(primary || compatibility), secret_name: primary ? definition.secret[0] : (compatibility ? definition.secret[1] : null),
      primary_secret_configured: Boolean(primary), compatibility_secret_configured: Boolean(compatibility),
      require_trusted_actors: trusted, require_risk_reviewer: reviewerStrict,
      reviewer_configured: owner === "risk" && validActor(env?.RISK_REVIEWER_ID), configuration_error: error.code || "OWNER_CONFIG_INVALID" };
  }
}

async function verifyOwnerRequest({ owner, body, headers, env }) {
  const definition = OWNER_FIELDS[owner];
  const config = resolveOwnerConfig(owner, env);
  const secret = config.secret;
  const actor = typeof body?.[definition.actor] === "string" ? body[definition.actor].trim() : null;
  if (!secret) {
    if (config.require_trusted_actors) {
      throw bridgeError("OWNER_AUTH_NOT_CONFIGURED", `${owner} 的可信身份验证尚未配置。`, { recovery: "配置对应 HMAC secret 后再启用 REQUIRE_TRUSTED_ACTORS。" });
    }
    return { owner, actor, mode: "DEMO_UNVERIFIED", verified: false, signature_header: definition.signature };
  }
  const supplied = headerValue(headers, definition.signature) || "";
  if (!supplied) throw bridgeError("OWNER_AUTH_REQUIRED", `${owner} 回写缺少签名。`, { statusCode: 401, stage: "AUTHENTICATION", recovery: `使用 ${definition.signature} 携带 sha256 HMAC 签名后重试。` });
  const expected = await signatureFor(body, secret);
  if (supplied.trim().toLowerCase() !== expected) {
    throw bridgeError("OWNER_AUTH_INVALID", `${owner} 回写签名无效。`, { statusCode: 401, stage: "AUTHENTICATION", recovery: "重新读取当前 Handoff，使用相同请求正文生成签名。" });
  }
  if (owner === "risk" && config.reviewer && actor !== config.reviewer) {
    throw bridgeError("OWNER_ACTOR_MISMATCH", "Risk reviewer does not match the fixed server-side identity.", {
      statusCode: 403, stage: "AUTHENTICATION", recovery: "Use the configured RISK_REVIEWER_ID; do not take reviewer identity from the user request."
    });
  }
  return { owner, actor, mode: "HMAC_SHA256", verified: true, signature_header: definition.signature,
    ...(owner === "risk" ? { fixed_reviewer_verified: Boolean(config.reviewer) } : {}) };
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
  const config = resolveOwnerConfig("risk", env);
  const envelope = buildRiskDispatchEnvelope(handoff);
  return postSignedJson({
    owner: "risk",
    url: ownerUrl("risk", env),
    secret: config.secret,
    body: envelope,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs || envValue(env, "RISK_SERVICE_TIMEOUT_MS") || 12000,
    allowInsecure: envValue(env, "ALLOW_INSECURE_OWNER_URL").toLowerCase() === "true"
  });
}

module.exports = { ADAPTER_VERSION, OWNER_FIELDS, canonicalize, canonicalJson, hmacHex, signatureFor, verifyOwnerRequest, ownerConfigurationStatus, buildRiskDispatchEnvelope, dispatchRiskHandoff, bridgeError };
