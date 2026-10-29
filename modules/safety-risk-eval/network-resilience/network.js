(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.RiskNetwork = factory();
}(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const MAX_RESPONSE_BYTES = 512 * 1024;
  const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
  const READ_METHODS = new Set(["GET"]);
  const INTERNAL_CODES = new Set(["NETWORK_TIMEOUT", "REDIRECT_REJECTED", "INVALID_RESPONSE", "RESPONSE_TOO_LARGE"]);

  class RiskNetworkError extends Error {
    constructor(code, message, sent, requiresReconciliation, httpStatus) {
      super(message);
      this.name = "RiskNetworkError";
      this.code = code;
      this.sent = sent;
      this.requiresReconciliation = requiresReconciliation;
      if (httpStatus !== undefined && httpStatus !== null) this.httpStatus = httpStatus;
    }
  }

  function internal(code) { return { riskNetworkCode: code }; }
  function object(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
  function timeout(value) { return Number.isInteger(value) && value >= 1 && value <= 300000; }
  function validRoute(route) {
    return typeof route === "string" && route.length > 0 && route.length <= 4096 && route[0] === "/" &&
      !/^\/(?:\/|%2f|%5c)/i.test(route) && !/[\\\u0000-\u0020\u007f#]/.test(route);
  }
  function safeRoute(route) { return route.split("?", 1)[0]; }
  function modelRoute(route) { return /\/(?:review|model|model-demo|model-review)\/?$/.test(safeRoute(route)); }
  function correlation(body) {
    const info = {};
    if (!object(body)) return info;
    const taskId = body.task_id || body.input && body.input.binding && body.input.binding.task_id;
    for (const entry of [["task_id", taskId], ["idempotency_key", body.idempotency_key]]) if (typeof entry[1] === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,179}$/.test(entry[1])) info[entry[0]] = entry[1];
    return info;
  }
  function notify(hook, info) {
    if (!hook) return;
    try {
      const result = hook(Object.assign({}, info));
      if (result && typeof result.then === "function") Promise.resolve(result).catch(function () {});
    } catch (_) { /* UI reporting must not change the network result. */ }
  }
  function safeServerDetail(data) {
    const value = object(data) && object(data.error) ? data.error.message : null;
    // Unknown English diagnostics, paths, HTML, tokens, and stack traces stay private.
    if (typeof value !== "string" || !/[\u3400-\u9fff]/.test(value) || /[\r\n\u0000-\u001f<>]/.test(value) ||
        /(?:https?:\/\/|[A-Za-z]:\\|\/(?:Users|home|var|tmp)\/|traceback|\bstack\b|\bat\s+\S+\(|authorization|bearer|api[_ -]?key|password|secret|token)/i.test(value)) return "";
    const trimmed = value.trim();
    return trimmed ? trimmed.slice(0, 160) : "";
  }
  function httpCode(status) {
    if (status === 401) return "HTTP_UNAUTHORIZED";
    if (status === 403) return "HTTP_FORBIDDEN";
    if (status === 429) return "HTTP_RATE_LIMITED";
    if (status >= 500) return "HTTP_SERVER_ERROR";
    if (status >= 400) return "HTTP_CLIENT_ERROR";
    return "HTTP_ERROR";
  }
  function message(code, uncertain, detail) {
    const messages = {
      INVALID_ROUTE: "只能请求当前网站内的相对接口地址。",
      INVALID_REQUEST: "请求参数格式不正确，尚未发送。",
      NETWORK_OFFLINE: "网络已断开，请恢复连接后再发起请求。",
      NETWORK_STATE_UNAVAILABLE: "暂时无法确认网络状态，本次尚未发送。",
      NETWORK_TIMEOUT: "等待服务响应超时。",
      NETWORK_ERROR: "无法取得服务响应，请检查网络连接。",
      INVALID_RESPONSE: "服务响应无法解析，请核查服务状态。",
      RESPONSE_TOO_LARGE: "服务响应超过大小限制，本次未采用该响应。",
      REDIRECT_REJECTED: "服务返回了未允许的跳转，请核查服务地址。",
      HTTP_UNAUTHORIZED: "登录或访问身份已失效，请重新确认访问权限。",
      HTTP_FORBIDDEN: "当前访问权限不足，服务已拒绝本次请求。",
      HTTP_RATE_LIMITED: "请求过于频繁或服务额度已达上限，请稍后查看。",
      HTTP_CLIENT_ERROR: "服务拒绝了本次请求，请核对输入资料。",
      HTTP_SERVER_ERROR: "服务暂时不可用。",
      HTTP_ERROR: "服务没有返回预期的成功响应。",
      SERVER_REPORTED_ERROR: "服务返回业务错误，请核查本次请求。"
    };
    return (messages[code] || messages.NETWORK_ERROR) + (detail ? " " + detail : "") +
      (uncertain ? " 本次处理结果未知，请先核查原请求，不要重复提交。" : "");
  }
  function declaredUncertain(data) {
    return object(data) && (data.requiresReconciliation === true || data.requires_reconciliation === true ||
      ["UNKNOWN", "RUNNING"].includes(data.status) || object(data.execution) && ["UNKNOWN", "RUNNING"].includes(data.execution.status) ||
      object(data.error) && (data.error.requires_reconciliation === true || data.error.requiresReconciliation === true ||
        ["REQUEST_RECONCILIATION_REQUIRED", "EXECUTION_STATUS_UNKNOWN"].includes(data.error.code)) ||
      object(data.risk_callback) && (data.risk_callback.requires_reconciliation === true || data.risk_callback.status === "UNKNOWN"));
  }

  async function readJson(response, deadline) {
    if (!/^application\/json(?:\s*;|$)/i.test(response.headers && response.headers.get("content-type") || "") || !response.body || typeof response.body.getReader !== "function") throw internal("INVALID_RESPONSE");
    const reader = response.body.getReader();
    try {
      const chunks = []; let size = 0;
      while (true) {
        const part = await Promise.race([reader.read(), deadline]);
        if (part.done) break;
        if (!(part.value instanceof Uint8Array)) throw internal("INVALID_RESPONSE");
        size += part.value.byteLength;
        if (size > MAX_RESPONSE_BYTES) throw internal("RESPONSE_TOO_LARGE");
        chunks.push(part.value);
      }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
      catch (_) { throw internal("INVALID_RESPONSE"); }
    } finally {
      try { const cancelled = reader.cancel(); if (cancelled && typeof cancelled.catch === "function") cancelled.catch(function () {}); }
      catch (_) { /* A broken body must not replace its original failure. */ }
    }
  }

  function createClient(settings) {
    const config = settings === undefined ? {} : settings;
    const fields = ["fetchImpl", "isOnline", "onUncertain", "onActivity", "defaultReadTimeoutMs", "defaultWriteTimeoutMs", "modelTimeoutMs"];
    if (!object(config) || Object.keys(config).some(function (key) { return !fields.includes(key); })) throw new TypeError("Unsupported RiskNetwork client options.");
    const fetchImpl = config.fetchImpl === undefined ? (typeof fetch === "function" ? fetch.bind(globalThis) : null) : config.fetchImpl;
    const isOnline = config.isOnline === undefined ? function () { return typeof navigator === "undefined" || navigator.onLine !== false; } : config.isOnline;
    const readTimeout = config.defaultReadTimeoutMs === undefined ? 10000 : config.defaultReadTimeoutMs;
    const writeTimeout = config.defaultWriteTimeoutMs === undefined ? 20000 : config.defaultWriteTimeoutMs;
    const modelTimeout = config.modelTimeoutMs === undefined ? 65000 : config.modelTimeoutMs;
    if (typeof fetchImpl !== "function" || typeof isOnline !== "function" || ![readTimeout, writeTimeout, modelTimeout].every(timeout) ||
        [config.onActivity, config.onUncertain].some(function (value) { return value !== undefined && typeof value !== "function"; })) throw new TypeError("Invalid RiskNetwork dependencies or timeouts.");

    async function requestJson(route, options) {
      const opts = options === undefined ? {} : options;
      if (!validRoute(route)) throw new RiskNetworkError("INVALID_ROUTE", message("INVALID_ROUTE"), false, false);
      if (!object(opts) || Object.keys(opts).some(function (key) { return !["method", "headers", "body", "timeoutMs"].includes(key); })) throw new RiskNetworkError("INVALID_REQUEST", message("INVALID_REQUEST"), false, false);
      const method = opts.method === undefined ? "GET" : typeof opts.method === "string" ? opts.method.toUpperCase() : "";
      const write = !READ_METHODS.has(method);
      const timeoutMs = opts.timeoutMs === undefined ? write ? modelRoute(route) ? modelTimeout : writeTimeout : readTimeout : opts.timeoutMs;
      let headers, body, bodyValue;
      try {
        if (!METHODS.has(method) || !timeout(timeoutMs) || !write && opts.body !== undefined) throw new Error("Invalid request.");
        headers = new Headers(opts.headers || {});
        if (!headers.has("Accept")) headers.set("Accept", "application/json");
        if (opts.body !== undefined) {
          body = typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
          if (typeof body !== "string") throw new Error("Invalid JSON request.");
          bodyValue = JSON.parse(body);
          if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
        }
      } catch (_) { throw new RiskNetworkError("INVALID_REQUEST", message("INVALID_REQUEST"), false, false); }
      const base = Object.assign({ route: safeRoute(route), method: method }, correlation(bodyValue));
      let online;
      try { online = isOnline(); }
      catch (_) { throw new RiskNetworkError("NETWORK_STATE_UNAVAILABLE", message("NETWORK_STATE_UNAVAILABLE"), false, false); }
      if (online === false) {
        const error = new RiskNetworkError("NETWORK_OFFLINE", message("NETWORK_OFFLINE"), false, false);
        notify(config.onActivity, Object.assign({}, base, { phase: "failed", code: error.code, sent: false, requiresReconciliation: false }));
        throw error;
      }

      const controller = new AbortController(); let rejectDeadline;
      const deadline = new Promise(function (_, reject) { rejectDeadline = reject; });
      const timer = setTimeout(function () { rejectDeadline(internal("NETWORK_TIMEOUT")); controller.abort(); }, timeoutMs);
      let sent = false, httpStatus = null;
      notify(config.onActivity, Object.assign({}, base, { phase: "started", sent: false, requiresReconciliation: false }));
      try {
        const response = await Promise.race([Promise.resolve().then(function () {
          sent = true;
          return fetchImpl(route, Object.assign({ method: method, headers: headers, redirect: "manual", credentials: "same-origin", signal: controller.signal }, body === undefined ? {} : { body: body }));
        }), deadline]);
        if (!response || !Number.isInteger(response.status)) throw internal("INVALID_RESPONSE");
        httpStatus = response.status;
        if (response.redirected || httpStatus >= 300 && httpStatus < 400 || response.type === "opaqueredirect") throw internal("REDIRECT_REJECTED");
        const data = await readJson(response, deadline);
        const returnedCorrelation = correlation(data);
        for (const key of ["task_id", "idempotency_key"]) if (!base[key] && returnedCorrelation[key]) base[key] = returnedCorrelation[key];
        const declared = write && sent && declaredUncertain(data);
        const pending = declared && (data.status === "RUNNING" || data.execution && data.execution.status === "RUNNING");
        if (httpStatus < 200 || httpStatus >= 300) {
          // A duplicate or throttled request may explicitly report an unresolved
          // original operation. Preserve that state instead of clearing its lock.
          const code = httpCode(httpStatus), uncertain = declared || write && sent && httpStatus >= 500;
          const error = new RiskNetworkError(code, message(code, uncertain && !pending, httpStatus < 500 ? safeServerDetail(data) : "") +
            (pending ? " 原请求仍在处理中，请核查原请求，不要重复提交。" : ""), sent, uncertain, httpStatus);
          error.pending = Boolean(pending);
          throw error;
        }
        if (object(data) && data.error) {
          const uncertain = write && sent;
          throw new RiskNetworkError("SERVER_REPORTED_ERROR", message("SERVER_REPORTED_ERROR", uncertain, safeServerDetail(data)), sent, uncertain, httpStatus);
        }
        const uncertain = declared;
        const activity = Object.assign({}, base, { phase: "succeeded", sent: sent, httpStatus: httpStatus, code: uncertain ? pending ? "SERVER_RESULT_PENDING" : "SERVER_RESULT_UNKNOWN" : null, pending: Boolean(pending), requiresReconciliation: uncertain });
        notify(config.onActivity, activity);
        if (uncertain) notify(config.onUncertain, activity);
        return data;
      } catch (caught) {
        let error = caught;
        if (!(error instanceof RiskNetworkError)) {
          const clientRejection = httpStatus >= 400 && httpStatus < 500;
          const serverFailure = httpStatus >= 500;
          const code = clientRejection || serverFailure ? httpCode(httpStatus) : INTERNAL_CODES.has(caught && caught.riskNetworkCode) ? caught.riskNetworkCode : "NETWORK_ERROR";
          const uncertain = write && sent && !clientRejection;
          error = new RiskNetworkError(code, message(code, uncertain), sent, uncertain, httpStatus);
        }
        const activity = Object.assign({}, base, { phase: "failed", code: error.code, sent: error.sent, requiresReconciliation: error.requiresReconciliation, pending: error.pending === true, httpStatus: httpStatus });
        notify(config.onActivity, activity);
        if (error.requiresReconciliation) notify(config.onUncertain, activity);
        throw error;
      } finally { clearTimeout(timer); controller.abort(); }
    }
    return { requestJson: requestJson };
  }

  return { createClient: createClient };
}));
