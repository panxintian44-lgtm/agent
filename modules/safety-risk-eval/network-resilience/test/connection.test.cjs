"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const network = require("../network.js");
const feedback = require("../feedback.js");
const source = fs.readFileSync(path.join(__dirname, "../connection.js"), "utf8");
const health = () => ({ schema_version: "risk-service-health.v1", overall: "UP", execution_allowed: false, business_acceptance: "NOT_VERIFIED",
  services: { workbench: { status: "UP" }, storage: { status: "UP" }, core: { status: "UP", model_configured: true, inference_probe: "NOT_RUN" } } });
const settle = () => new Promise(resolve => setImmediate(resolve));

function fixture({ saved = null, failWrite = false, failedHealth = false, hangWrite = false, unavailableStorage = false, unavailableCore = false } = {}) {
  const elements = new Map(), store = new Map(), calls = [], timers = new Map(); let timerIndex = 0;
  if (saved) store.set("risk-pending-network-operation.v1", JSON.stringify(saved));
  const element = id => {
    if (!elements.has(id)) {
      const item = new EventTarget(); Object.assign(item, { textContent: "", disabled: false, hidden: false, dataset: {}, setAttribute() {}, prepend() {} });
      Object.defineProperty(item, "innerHTML", { set(html) { for (const match of html.matchAll(/id="([^"]+)"/g)) element(match[1]); } });
      elements.set(id, item);
    }
    return elements.get(id);
  };
  for (const id of ["create", "approve", "execute", "daily-check", "daily-execute"]) element(id);
  const document = new EventTarget(); Object.assign(document, { hidden: false, createElement: () => element("panel"), querySelector: () => element("main"), querySelectorAll: () => [], getElementById: id => elements.get(id) || null });
  const window = new EventTarget();
  window.addEventListener("risk:connection", () => { for (const id of ["create", "approve", "execute", "daily-check", "daily-execute"]) element(id).disabled = false; });
  let lastUncertain, finishWrite, currentNotice = null;
  const notices = [];
  window.RiskFeedback = { createPresenter: () => ({ show(info) { currentNotice = feedback.describe(info); notices.push(currentNotice); }, hide() { currentNotice = null; }, current() { return currentNotice; } }) };
  window.RiskNetwork = { createClient: options => network.createClient({ ...options, onUncertain: info => { lastUncertain = info; options.onUncertain(info); }, fetchImpl: async (route, options) => {
    calls.push({ route, method: options.method });
    if (route === "/api/safety/health") { if (failedHealth) throw new Error("SYNTHETIC_NETWORK_FAILURE"); const value = health(); if (unavailableCore) { value.services.core.status = "UNAVAILABLE"; value.overall = "DEGRADED"; } return Response.json(value); }
    if (options.method === "POST" && failWrite) throw new Error("SYNTHETIC_LOST_RESPONSE");
    if (options.method === "POST" && hangWrite) return new Promise(resolve => { finishWrite = () => resolve(Response.json({ status: "OK" })); });
    if (route.startsWith("/api/safety/task")) return Response.json({ task_id: saved?.task_id || "synthetic-task", execution: { status: "NOT_STARTED" } });
    return Response.json({ status: "OK" });
  } }) };
  const context = { window, document, navigator: { onLine: true }, sessionStorage: { getItem: key => store.get(key), setItem: (key, value) => { if (unavailableStorage) throw new Error("SYNTHETIC_STORAGE_DENIED"); store.set(key, value); }, removeItem: key => store.delete(key) },
    Event, CustomEvent, Intl, Date, console, queueMicrotask, setTimeout: (fn, ms) => { const id = ++timerIndex; timers.set(id, { fn, ms }); return id; }, clearTimeout: id => timers.delete(id) };
  vm.runInNewContext(source, context);
  return { window, document, elements, calls, store, timers, element, notices, notice: () => currentNotice, setCoreAvailable() { unavailableCore = false; }, lastUncertain: () => lastUncertain, finishWrite: () => finishWrite() };
}

test("opening the page only reads health and never submits business operations", async () => {
  const f = fixture(); await settle();
  assert.deepEqual(f.calls, [{ route: "/api/safety/health", method: "GET" }]);
  assert.equal(f.element("create").disabled, false);
  assert.match(f.element("connection-summary").textContent, /不代表任务已经获批/);
  assert.equal([...f.timers.values()][0].ms, 30000);
});
test("offline is visible immediately and reconnect only rechecks GET health", async () => {
  const f = fixture(); await settle(); f.window.dispatchEvent(new Event("offline"));
  assert.match(f.element("connection-summary").textContent, /网络已断开/);
  assert.equal(f.element("execute").disabled, true);
  await assert.rejects(f.window.RiskConnection.request("/api/paper-trade/execute", { task_id: "synthetic-task" }), /网络已断开/);
  assert.equal(f.calls.length, 1);
  f.window.dispatchEvent(new Event("online")); await settle();
  assert.equal(f.calls.length, 2); assert.equal(f.calls.every(row => row.method === "GET"), true);
});
test("unknown submitted writes keep the original identifiers and block new writes", async () => {
  const f = fixture({ failWrite: true }); await settle();
  await assert.rejects(f.window.RiskConnection.request("/api/paper-trade/execute", { task_id: "synthetic-task", idempotency_key: "synthetic-key" }, { csrf: "test-only" }));
  assert.equal(f.lastUncertain().task_id, "synthetic-task");
  assert.equal(f.element("execute").disabled, true);
  await assert.rejects(f.window.RiskConnection.request("/api/safety/daily/tasks", {}), /上一项操作结果待核查/);
  assert.equal(f.calls.filter(row => row.method === "POST").length, 1);
  const saved = JSON.parse(f.store.get("risk-pending-network-operation.v1"));
  assert.equal(saved.idempotency_key, "synthetic-key"); assert.equal(JSON.stringify(saved).includes("test-only"), false);
});
test("pending writes survive reload and reading old NOT_STARTED is not proof of failure", async () => {
  const saved = { route: "/api/paper-trade/execute", task_id: "synthetic-task", idempotency_key: "synthetic-key", at: new Date().toISOString() };
  const f = fixture({ saved }); await settle();
  assert.equal(f.element("execute").disabled, true);
  f.element("connection-query").dispatchEvent(new Event("click")); await settle();
  assert.equal(f.store.has("risk-pending-network-operation.v1"), true);
  assert.match(f.element("connection-pending-message").textContent, /不足以确认/);
  assert.equal(f.calls.every(row => row.method === "GET"), true);
});
test("hidden tabs pause polling and visible tabs perform a new read", async () => {
  const f = fixture(); await settle();
  f.document.hidden = true; f.document.dispatchEvent(new Event("visibilitychange"));
  assert.equal(f.timers.size, 0); assert.equal(f.calls.length, 1);
  f.document.hidden = false; f.document.dispatchEvent(new Event("visibilitychange")); await settle();
  assert.equal(f.calls.length, 2); assert.equal(f.calls.every(row => row.method === "GET"), true);
  f.window.dispatchEvent(new Event("pagehide")); assert.equal(f.timers.size, 0);
});
test("failed health checks never retain a green label or allow writes", async () => {
  const f = fixture({ failedHealth: true }); await settle();
  assert.equal(f.element("panel").dataset.state, "error");
  assert.match(f.element("connection-summary").textContent, /暂时无法核实/);
  await assert.rejects(f.window.RiskConnection.request("/api/safety/confirm", { task_id: "synthetic-task" }), /服务状态尚未核实/);
  assert.equal(f.calls.length, 1);
});
test("an in-flight write is recorded before sending and a reloaded page cannot resubmit", async () => {
  const f = fixture({ hangWrite: true }); await settle();
  const write = f.window.RiskConnection.request("/api/paper-trade/execute", { task_id: "synthetic-task", idempotency_key: "synthetic-key" });
  write.catch(() => {});
  const saved = JSON.parse(f.store.get("risk-pending-network-operation.v1"));
  assert.equal(saved.state, "IN_FLIGHT"); assert.equal(saved.idempotency_key, "synthetic-key");
  const reloaded = fixture({ saved }); await settle();
  await assert.rejects(reloaded.window.RiskConnection.request("/api/paper-trade/execute", { task_id: "synthetic-task" }), /上一项操作结果待核查/);
  assert.equal(reloaded.calls.every(row => row.method === "GET"), true);
  f.finishWrite(); await write;
});
test("storage failure prevents sending a write rather than losing the cross-refresh guard", async () => {
  const f = fixture({ unavailableStorage: true }); await settle();
  await assert.rejects(f.window.RiskConnection.request("/api/safety/confirm", { task_id: "synthetic-task" }), /尚未发送/);
  assert.equal(f.calls.every(row => row.method === "GET"), true);
  assert.equal(f.notice().code, "LOCAL_STORAGE_UNAVAILABLE");
  assert.match(f.notice().state, /未发送/);
});

test("an operation failure remains visible after successful health checks", async () => {
  const f = fixture({ failWrite: true }); await settle();
  await assert.rejects(f.window.RiskConnection.request("/api/paper-trade/execute", { task_id: "synthetic-task", idempotency_key: "synthetic-key" }));
  const before = f.notice();
  assert.equal(before.requiresReconciliation, true);
  await f.window.RiskConnection.checkHealth();
  assert.equal(f.notice(), before);
  assert.match(f.notice().state, /核查/);
  assert.equal(f.element("execute").disabled, true);
});

test("local validation feedback is visible without making a business request", async () => {
  const f = fixture(); await settle();
  const message = f.window.RiskConnection.reportUiError();
  assert.equal(f.notice().code, "INPUT_VALIDATION");
  assert.match(message, /资料|确认/);
  assert.equal(f.calls.every(row => row.method === "GET"), true);
});

test("health recovery cannot dismiss an operation error sharing a health error code", async () => {
  const f = fixture({ unavailableCore: true }); await settle();
  await assert.rejects(f.window.RiskConnection.request("/api/safety/model-review", { task_id: "synthetic-task" }), /模型后端/);
  const notice = f.notice(); assert.equal(notice.code, "CORE_UNAVAILABLE"); assert.equal(notice.operation, "模型复核");
  f.setCoreAvailable(); await f.window.RiskConnection.checkHealth();
  assert.equal(f.notice(), notice);
  assert.equal(f.calls.every(row => row.method === "GET"), true);
});
