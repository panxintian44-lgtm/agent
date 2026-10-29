"use strict";
const Ajv = require("ajv/dist/2020");
const schema = require("../../../chenchen/contracts/risk-handoff.v1.schema.json");
const { ConversationError } = require("./conversation-input.cjs");
const { extractCoreBinding } = require("./risk-callback.cjs");
const ajv = new Ajv({ strict: false, allErrors: true });
for (const name of ["agent-output.v1", "model-review.v1", "owner-bridge.v1", "funding-plan-demo.v1"]) ajv.addSchema(require(`../../../chenchen/contracts/${name}.schema.json`));
ajv.addSchema(schema);
const validateHandoff = ajv.compile({ $ref: `${schema.$id}#/$defs/HandoffPackage` });

function validateBaseUrl(baseUrl, allowLocalHttp = false) {
  let url; try { url = new URL(baseUrl); } catch { throw new ConversationError("CORE_URL_INVALID", "Core服务地址尚未正确配置。", 503); }
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/" ||
    !(url.protocol === "https:" || allowLocalHttp && url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) throw new ConversationError("CORE_URL_INVALID", "Core地址须为服务端配置的HTTPS域名；本机测试例外须显式启用。", 503);
  return url.origin;
}
function assertHandoff(value, pending = true) {
  if (!validateHandoff(value)) throw new ConversationError("CORE_HANDOFF_SCHEMA_INVALID", "Core交接包未通过官方完整Schema校验，已暂停相关流程。", 502);
  if (pending) extractCoreBinding(value);
  return value;
}
function createCoreClient({ baseUrl, apiKey, allowLocalHttp = false, timeoutMs = 60000, fetchImpl = fetch }) {
  const root = validateBaseUrl(baseUrl, allowLocalHttp);
  async function request(route, value) {
    if (typeof route !== "string" || !route.startsWith("/api/review") || route.startsWith("//")) throw new ConversationError("CORE_ROUTE_FORBIDDEN", "请求路径不在统一Core范围内。", 500);
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), Math.min(65000, Math.max(1000, timeoutMs)));
    let reader;
    try {
      const response = await fetchImpl(root + route, { method: value === undefined ? "GET" : "POST", redirect: "manual", signal: controller.signal,
        headers: { Accept: "application/json", ...(value === undefined ? {} : { "Content-Type": "application/json" }), ...(apiKey ? { "X-Core-Agent-Key": apiKey } : {}) },
        ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
      if (response.redirected || response.status >= 300 && response.status < 400) throw new ConversationError("CORE_REDIRECT_REJECTED", "Core重定向被拒绝，凭据不会转发到其他地址。", 502);
      if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") || "") || !response.body) throw new ConversationError("CORE_INVALID_RESPONSE", "Core未返回有效JSON。", 502);
      reader = response.body.getReader(); const chunks = []; let bytes = 0;
      while (true) { const part = await reader.read(); if (part.done) break; bytes += part.value.length; if (bytes > 512 * 1024) throw new ConversationError("CORE_RESPONSE_TOO_LARGE", "Core响应超出大小限制。", 502); chunks.push(part.value); }
      const joined = new Uint8Array(bytes); let offset = 0; for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.length; }
      let data; try { data = JSON.parse(new TextDecoder().decode(joined)); } catch { throw new ConversationError("CORE_INVALID_RESPONSE", "Core返回了无效JSON。", 502); }
      if (!response.ok || data.error) throw new ConversationError("CORE_REQUEST_FAILED", "统一模型后端调用失败；未切换为离线结果。", response.status >= 400 ? response.status : 502);
      return data;
    } catch (error) {
      if (error instanceof ConversationError) throw error;
      throw new ConversationError("CORE_UNAVAILABLE", "统一模型后端超时或不可达；本次调用失败，执行保持关闭。", 503);
    } finally { clearTimeout(timer); if (reader) void reader.cancel().catch(() => {}); }
  }
  return { request, root, handoff: async runId => assertHandoff(await request(`/api/review/${encodeURIComponent(runId)}/risk-handoff`)),
    task: taskId => request(`/api/review/task/${encodeURIComponent(taskId)}`) };
}
module.exports = { createCoreClient, validateBaseUrl, assertHandoff };
