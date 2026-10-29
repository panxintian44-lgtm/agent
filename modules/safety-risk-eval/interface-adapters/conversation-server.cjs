"use strict";
const http = require("node:http");
const path = require("node:path");
const { timingSafeEqual } = require("node:crypto");
const { ConversationStore } = require("./conversation-store.cjs");
const { createConversationReviewer } = require("./conversation-review.cjs");
const { ConversationError } = require("./conversation-input.cjs");

function equalKey(received, expected) {
  if (typeof received !== "string" || typeof expected !== "string" || expected.length < 24 || received.length > 10000) return false;
  const left = Buffer.from(received), right = Buffer.from(expected); return left.length === right.length && timingSafeEqual(left, right);
}
function send(res, status, data) { res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }); res.end(JSON.stringify(data)); }
async function json(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 128 * 1024) throw new ConversationError("BODY_TOO_LARGE", "问题和资料超过大小限制。", 413); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new ConversationError("INVALID_JSON", "请求须为有效JSON。", 400); }
}
function createConversationServer({ env = process.env, directory = path.join(__dirname, ".runtime"), store = new ConversationStore(directory), fetchImpl = fetch, now } = {}) {
  const config = { baseUrl: env.CORE_AGENT_BASE_URL || "https://personal-ai-fund-manager-core-agent.realchenchenluo.workers.dev", apiKey: env.CORE_AGENT_API_KEY,
    hmacSecret: env.RISK_SERVICE_HMAC_SECRET || env.RISK_HMAC_SECRET, reviewer: env.RISK_REVIEWER_ID, allowLocalHttp: env.RISK_ALLOW_LOCAL_HTTP === "true", timeoutMs: Number(env.RISK_CORE_TIMEOUT_MS || 60000), dailyLimit: Number(env.RISK_CONVERSATION_DAILY_LIMIT || 20) };
  const reviewer = createConversationReviewer({ store, config, fetchImpl, now });
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || "invalid"}`);
      if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || Number(url.port || 80) !== server.address().port || req.headers.origin) throw new ConversationError("SERVICE_ORIGIN_DENIED", "该接口仅供受信任本机问答服务调用。", 403);
      if (!equalKey(req.headers["x-risk-conversation-key"], env.RISK_CONVERSATION_API_KEY)) throw new ConversationError("SERVICE_AUTH_REQUIRED", "缺少有效的问答服务身份。", 401);
      if (url.pathname === "/api/status" && req.method === "GET") return send(res, 200, { configured: Boolean(config.apiKey && config.hmacSecret && config.reviewer), mode: "READ_ONLY_CONVERSATION", execution_allowed: false, real_model_verified: false });
      if (url.pathname !== "/api/review" || req.method !== "POST") throw new ConversationError("NOT_FOUND", "接口不存在。", 404);
      if (!/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] || "")) throw new ConversationError("INVALID_CONTENT_TYPE", "请求须使用application/json。", 415);
      const result = await reviewer.review(await json(req)); send(res, 200, result);
    } catch (error) {
      send(res, error.status || error.statusCode || 503, { engine: "risk-conversation", decision_source: "unavailable", model_status: "unavailable", ...error.partial, executed: false, execution_allowed: false, queued: false,
        error: { code: error.code || "RISK_CONVERSATION_UNAVAILABLE", message: error.code ? error.message : "问答风控服务不可用，本次未执行操作。" } });
    }
  });
  return { server, store, reviewer, close: () => { server.close(); store.close(); } };
}
if (require.main === module) {
  const app = createConversationServer(), port = Number(process.env.RISK_CONVERSATION_PORT || 8790);
  app.server.listen(port, "127.0.0.1", () => process.stdout.write(`Risk conversation service listening on 127.0.0.1:${port}\n`));
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { app.close(); process.exit(0); });
}
module.exports = { createConversationServer };
