import assert from "node:assert/strict";
import test from "node:test";
import worker, { ReviewService } from "../deployment/worker.js";

test("deployed handler wires durable Bailian accounting, blocked execution and task replay", async t => {
  const data = new Map();
  const storage = { get: async key => structuredClone(data.get(key)),
    put: async entries => { for (const [key, value] of Object.entries(entries)) data.set(key, structuredClone(value)); } };
  const env = { MODEL_PROVIDER: "aliyun_bailian", DASHSCOPE_API_KEY: "synthetic-provider-key",
    CORE_AGENT_API_KEY: "synthetic-backend-key", BAILIAN_WORKSPACE_ID: "llm-test", BAILIAN_TEST_BUDGET_CNY: "0.01",
    BAILIAN_ALLOW_PAID_CALLS: "true", RATE_LIMIT_PER_MINUTE: "0", REQUIRE_TRUSTED_ACTORS: "true", RISK_REVIEWER_ID: "synthetic-risk" };
  let service = new ReviewService({ storage }, env);
  env.REVIEW_SERVICE = { idFromName: name => name, get: () => service };
  let calls = 0;
  const logs = [];
  t.mock.method(console, "log", line => logs.push(JSON.parse(line)));
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls++;
    assert.equal(options.headers.Authorization, "Bearer synthetic-provider-key");
    assert.ok(url.startsWith("https://llm-test.cn-beijing.maas.aliyuncs.com/"));
    return new Response(JSON.stringify({ id: "test-provider-id", usage: { total_tokens: 99, prompt_tokens: 60, completion_tokens: 39 },
      choices: [{ message: { content: JSON.stringify({ summary: "信息不足", risk_level: "unknown", proposed_action: "REQUEST_MORE_INFO",
        action_reason: "缺少真实账户数据", missing_information: ["账户数据"], evidence: [] }) } }] }));
  });
  const request = (path, body, key = env.CORE_AGENT_API_KEY) => new Request("https://test.invalid" + path, {
    method: body === undefined ? "GET" : "POST", headers: { "X-Core-Agent-Key": key, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const input = { text: "虚构账户查询", idempotency_key: "bailian-worker-idem" };
  const denied = await worker.fetch(request("/api/review", input, "wrong"), env);
  assert.equal(denied.status, 401);
  assert.equal(calls, 0);
  const response = await worker.fetch(request("/api/review", input), env);
  assert.equal(response.status, 200);
  const created = await response.json();
  assert.equal(created.model.model_response.provider, "aliyun_bailian");
  assert.equal(created.status, "PENDING_RISK");
  assert.equal(created.execution.execution_allowed, false);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].usage.total_tokens, 99);
  assert.equal(logs[0].run_id, created.run_id);
  assert.equal(JSON.stringify(logs).includes(env.DASHSCOPE_API_KEY), false);
  service = new ReviewService({ storage }, env);
  const replay = await worker.fetch(request("/api/review", input), env).then(r => r.json());
  assert.equal(replay.run_id, created.run_id);
  assert.equal(calls, 1);
  const overBudget = await worker.fetch(request("/api/review", { text: "另一条虚构任务" }), env);
  assert.equal(overBudget.status, 429);
  const failure = await overBudget.json();
  assert.equal(failure.workflow.execution.execution_allowed, false);
  assert.equal(calls, 1);
  const loaded = await worker.fetch(request("/api/review/task/" + failure.workflow.task_id), env).then(r => r.json());
  assert.equal(loaded.status, "MODEL_FAILED");
  const simulation = await worker.fetch(request("/api/review/simulate", { task_id: created.task_id, proposal_sha256: created.proposed_action.proposal_sha256 }), env);
  assert.equal(simulation.status, 409);
  const risk = await worker.fetch(request("/api/review/risk-dispatch", { task_id: created.task_id, proposal_sha256: created.proposed_action.proposal_sha256 }), env);
  assert.equal(risk.status, 503);
  assert.equal((await risk.json()).error.code, "RISK_OWNER_NOT_CONFIGURED");
});
