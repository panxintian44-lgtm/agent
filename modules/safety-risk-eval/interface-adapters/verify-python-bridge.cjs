"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { createConversationServer } = require("./conversation-server.cjs");
const { ConversationStore } = require("./conversation-store.cjs");
const { ReviewWorkflowStore } = require("../../../chenchen/integrations/review-workflow.js");
const { buildRiskHandoffPackage } = require("../../../chenchen/integrations/risk-handoff.js");
const { verifyOwnerRequest } = require("../../../chenchen/integrations/owner-bridge.js");

// Real local Python/Node HTTP and Core workflow; explicitly synthetic model only.
async function main() {
  const python = process.env.PYTHON_EXECUTABLE;
  if (!python) throw new Error("Set PYTHON_EXECUTABLE to a Python with Finance Lab requirements installed.");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "risk-python-bridge-"));
  const journal = new ConversationStore(directory); let child, app, modelCalls = 0;
  const secret = "synthetic-bridge-only-signing-secret", appKey = "synthetic-private-bridge-service-key-1234";
  const core = new ReviewWorkflowStore({ modelRunner: async input => {
    modelCalls++;
    const proposal = { proposed_action: "HOLD_FOR_REVIEW", action_reason: "SYNTHETIC bridge test model response", risk_level: "medium" };
    return { run_id: `synthetic-run-${randomUUID()}`, status: "PROPOSED", source: "model", input: { kind: input.kind, input_sha256: "a".repeat(64) },
      model_response: { call_succeeded: true, model: "TEST_DOUBLE_NO_REAL_MODEL_CALL", provider_response_id: null, proposal, raw_text: JSON.stringify(proposal) },
      audit: { audit_id: `synthetic-audit-${randomUUID()}`, events: [] } };
  } });
  try {
    app = createConversationServer({ store: journal, env: { RISK_CONVERSATION_API_KEY: appKey, CORE_AGENT_BASE_URL: "https://core.synthetic.invalid", CORE_AGENT_API_KEY: "synthetic-core-key", RISK_SERVICE_HMAC_SECRET: secret, RISK_REVIEWER_ID: "synthetic-risk-owner" }, fetchImpl: async (url, options = {}) => {
      const route = new URL(url).pathname;
      if (route === "/api/review") return Response.json(await core.start(JSON.parse(options.body)));
      if (route.endsWith("/risk-handoff")) return Response.json(buildRiskHandoffPackage(core.getByRunId(decodeURIComponent(route.split("/")[3]))));
      if (route.startsWith("/api/review/task/")) return Response.json(core.getByTaskId(decodeURIComponent(route.slice("/api/review/task/".length))));
      if (route === "/api/review/risk-callback") {
        const callback = JSON.parse(options.body), auth = await verifyOwnerRequest({ owner: "risk", body: callback, headers: new Headers(options.headers), env: { RISK_SERVICE_HMAC_SECRET: secret, REQUIRE_TRUSTED_ACTORS: "true" } });
        return Response.json(await core.receiveRiskCallback(callback, auth));
      }
      throw new Error("Unexpected synthetic Core route");
    } });
    await new Promise(resolve => app.server.listen(0, "127.0.0.1", resolve));
    const script = "from http.server import ThreadingHTTPServer\nfrom web.app import Handler\ns=ThreadingHTTPServer(('127.0.0.1',0),Handler)\nprint(s.server_port,flush=True)\ns.serve_forever()";
    child = spawn(python, ["-u", "-c", script], { env: { ...process.env, PYTHONPATH: path.resolve(__dirname, "../../../qiqi"), RISK_CONVERSATION_BASE_URL: `http://127.0.0.1:${app.server.address().port}`, RISK_CONVERSATION_API_KEY: appKey }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const port = await new Promise((resolve, reject) => {
      let buffer = ""; const timer = setTimeout(() => reject(new Error("Python bridge startup timed out")), 15000);
      child.once("error", reject); child.once("exit", code => { clearTimeout(timer); reject(new Error("Python bridge exited: " + code)); });
      child.stdout.on("data", chunk => { buffer += chunk; const match = /^(\d+)\r?\n/.exec(buffer); if (match) { clearTimeout(timer); resolve(Number(match[1])); } });
    });
    const today = new Date(), due = new Date(today.getTime() + 10 * 86400000).toISOString().slice(0, 10);
    const payload = { question: "我想投资8000元，但必须保留4000元房租。", idempotency_key: "synthetic-real-http-bridge", daily_finance_yuan: {
      cash_yuan: "10000", amount_yuan: "8000", fees_yuan: "0", holds_yuan: "0", floor_yuan: "0", purpose_yuan: "4000", due_yuan: "4000", due_date: due, purpose_label: "房租", facts_confirmed: true, purpose_confirmed: true } };
    const call = async body => {
      const response = await fetch(`http://127.0.0.1:${port}/api/review`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = await response.json(); assert.equal(response.status, 200, JSON.stringify(data)); return data;
    };
    const result = await call(payload);
    assert.equal(result.risk_advice.decision, "BLOCK"); assert.equal(result.risk_advice.metrics.shortfall_yuan, "2000.00");
    assert.equal(result.risk_callback.status, "RECORDED"); assert.equal(result.risk_decision.auth.verified, true); assert.equal(result.risk_decision.task_id, result.task_id);
    assert.equal(result.execution_allowed, false); assert.equal(result.executed, false); assert.equal(result.conversation_mode, "READ_ONLY_CONVERSATION");
    assert.equal((await call(payload)).replayed, true); assert.equal(modelCalls, 1);
    process.stdout.write(JSON.stringify({ mode: "LOCAL_PYTHON_NODE_HTTP_WITH_CORE_CONTRACT_TEST_DOUBLE", result: "PASS", real_model_calls: 0, synthetic_model_calls: modelCalls, risk: result.risk_advice.decision, callback: result.risk_callback.status, shortfall_yuan: result.risk_advice.metrics.shortfall_yuan, execution_allowed: false, idempotent_replay: true }) + "\n");
  } finally {
    if (child) child.kill(); if (app?.server.listening) await new Promise(resolve => app.server.close(resolve));
    journal.close(); fs.rmSync(directory, { recursive: true, force: true });
  }
}
main().catch(error => { process.stderr.write((error.code || error.message) + "\n"); process.exitCode = 1; });
