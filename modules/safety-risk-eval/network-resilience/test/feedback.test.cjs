"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createPresenter, describe } = require("../feedback.js");

class Element {
  constructor(tag) {
    this.tagName = tag; this.children = []; this.attributes = {}; this.listeners = {};
    this.hidden = false; this.disabled = false; this._text = ""; this.id = "";
  }
  appendChild(element) { this.children.push(element); return element; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  addEventListener(type, callback) { (this.listeners[type] ||= []).push(callback); }
  click() { if (!this.disabled) for (const listener of this.listeners.click || []) listener({ type: "click" }); }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join("\n"); }
  set innerHTML(_) { throw new Error("The presenter must never use innerHTML."); }
}
function documentFixture() {
  const body = new Element("body");
  return {
    body, createElement: tag => new Element(tag),
    getElementById: id => {
      function find(element) { return element.id === id ? element : element.children.map(find).find(Boolean); }
      return find(body) || null;
    }
  };
}

test("the UMD browser global and CommonJS both expose the presenter and describe API", () => {
  const sandbox = { document: documentFixture(), setTimeout: () => { throw new Error("No automatic dismiss timer is allowed."); } };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../feedback.js"), "utf8"), sandbox);
  assert.equal(typeof sandbox.RiskFeedback.createPresenter, "function");
  assert.equal(typeof sandbox.RiskFeedback.describe, "function");
  const presenter = sandbox.RiskFeedback.createPresenter({ document: sandbox.document });
  presenter.show({ code: "NETWORK_TIMEOUT", method: "POST", requiresReconciliation: true });
  assert.equal(sandbox.document.getElementById("risk-operation-alert").hidden, false);
});

test("the panel starts hidden and has fixed accessible identifiers", () => {
  const document = documentFixture(), presenter = createPresenter({ document });
  const panel = document.getElementById("risk-operation-alert");
  assert.equal(panel.hidden, true);
  assert.equal(panel.getAttribute("role"), "alert");
  assert.equal(panel.getAttribute("aria-live"), "assertive");
  for (const suffix of ["title", "problem", "state", "recovery", "reference", "close", "check", "query"]) assert.ok(document.getElementById("operation-error-" + suffix));
  assert.equal(document.getElementById("operation-error-query").hidden, true);
  assert.equal(presenter.current(), null);
});

for (const code of ["NETWORK_TIMEOUT", "NETWORK_OFFLINE", "NETWORK_ERROR", "HTTP_SERVER_ERROR", "HTTP_UNAUTHORIZED", "HTTP_FORBIDDEN", "HTTP_RATE_LIMITED", "HTTP_CLIENT_ERROR", "LOCAL_STORAGE_UNAVAILABLE", "CORE_UNAVAILABLE", "CONNECTION_NOT_READY", "HEALTH_UNAVAILABLE", "INPUT_VALIDATION"]) {
  test(`known ${code} produces fixed Chinese problem and recovery text`, () => {
    const result = describe({ code, operation: "风险检查", method: "POST", sent: false });
    assert.equal(result.code, code);
    assert.match(result.problem, /[\u3400-\u9fff]/);
    assert.match(result.recovery, /[\u3400-\u9fff]/);
    assert.equal(result.state, "本次请求尚未发送。");
    assert.equal(result.reference, "原因代码：" + code);
  });
}

test("uncertain state has priority over both HTTP denial and a contradictory unsent flag", () => {
  const result = describe({ code: "HTTP_RATE_LIMITED", operation: "用户确认", method: "POST", sent: false, requiresReconciliation: true, task_id: "task-original" });
  assert.match(result.title, /结果待核查/);
  assert.match(result.state, /结果待核查/);
  assert.equal(result.state.includes("尚未发送"), false);
  assert.equal(result.showQuery, true);
  assert.match(result.recovery, /不要重复提交/);
});

test("pending state says still processing rather than inventing a failed operation", () => {
  const result = describe({ code: "SERVER_RESULT_PENDING", operation: "模拟执行", method: "POST", pending: true, task_id: "task-running" });
  assert.equal(result.requiresReconciliation, true);
  assert.equal(result.pending, true);
  assert.match(result.state, /仍在处理中/);
  assert.equal(result.state.includes("失败"), false);
  assert.equal(result.state.includes("已完成"), false);
});

test("stable unknown and pending-operation codes cannot lose their reconciliation state", () => {
  for (const code of ["SERVER_RESULT_UNKNOWN", "PENDING_OPERATION_REQUIRES_RECONCILIATION"]) {
    const result = describe({ code, sent: true, task_id: "task-keep" });
    assert.equal(result.requiresReconciliation, true);
    assert.equal(result.showQuery, true);
  }
});

test("GET failure never claims that the underlying business was rejected or never executed", () => {
  for (const code of ["HTTP_SERVER_ERROR", "HTTP_FORBIDDEN", "HEALTH_UNAVAILABLE", "NETWORK_TIMEOUT"]) {
    const result = describe({ code, method: "GET", sent: true, operation: "服务连接检查" });
    assert.match(result.state, /本次读取未完成/);
    assert.match(result.state, /不能据此判断原业务是否已执行/);
    assert.equal(result.state.includes("当前操作不能继续执行"), false);
    assert.equal(result.state.includes("业务未执行"), false);
  }
});

test("a known rejected POST remains blocked without claiming a completed execution", () => {
  const result = describe({ code: "HTTP_FORBIDDEN", operation: "用户确认", method: "POST", sent: true });
  assert.match(result.state, /服务已拒绝本次请求/);
  assert.match(result.state, /当前操作不能继续执行/);
  assert.equal(result.requiresReconciliation, false);
});

test("unknown codes and operation names are replaced rather than displayed", () => {
  const result = describe({ code: "secret-server-code", operation: "private operation raw text", message: "private error", task_id: "<script>raw</script>" });
  assert.equal(result.code, "REQUEST_FAILED");
  assert.equal(result.operation, "当前操作");
  assert.equal(result.task_id, null);
  assert.equal(result.reference, "原因代码：REQUEST_FAILED");
  for (const text of ["secret", "private", "script", "raw"]) assert.equal(JSON.stringify(result).includes(text), false);
});

test("task identifiers are bounded and cannot carry arbitrary server paragraphs", () => {
  assert.equal(describe({ task_id: "task-safe:run_1.2" }).task_id, "task-safe:run_1.2");
  for (const task_id of ["x".repeat(121), "task one", "中文服务原文", "task\nsecret", "task<script>", "https://private.invalid"]) assert.equal(describe({ task_id }).task_id, null);
});

test("the exact fixed operation whitelist is accepted", () => {
  for (const operation of ["风险检查", "模型复核", "用户确认", "撤回确认", "模拟执行", "读取任务", "读取记录", "服务连接检查", "当前操作"]) assert.equal(describe({ operation }).operation, operation);
});

test("show only writes sanitized textContent and exposes no raw error payload or credentials", () => {
  const document = documentFixture(), presenter = createPresenter({ document });
  const result = presenter.show({ code: "NETWORK_TIMEOUT", operation: "模型复核", method: "POST", sent: true, requiresReconciliation: true, task_id: "task-safe",
    message: "<img src=x onerror=private> token=secret", raw: "raw-secret", body: { password: "password-secret" }, token: "token-secret", reference: "forged-reference", title: "forged-title" });
  const text = document.body.textContent;
  for (const secret of ["<img", "onerror", "private", "secret", "forged-reference", "forged-title"]) assert.equal(text.includes(secret), false);
  assert.equal(document.getElementById("operation-error-title").textContent, result.title);
  assert.equal(document.getElementById("operation-error-reference").textContent, "原因代码：NETWORK_TIMEOUT\n任务编号：task-safe");
  assert.equal(document.getElementById("risk-operation-alert").hidden, false);
  assert.equal(JSON.stringify(presenter.current()).includes("token-secret"), false);
});

test("show and close never check, query, unlock or retry an operation", () => {
  const document = documentFixture(); let checks = 0, queries = 0;
  const presenter = createPresenter({ document, onCheck: () => { checks++; }, onQuery: () => { queries++; } });
  presenter.show({ code: "SERVER_RESULT_UNKNOWN", task_id: "task-original", operation: "模拟执行", method: "POST", sent: true });
  assert.equal(checks, 0); assert.equal(queries, 0);
  const before = presenter.current();
  document.getElementById("operation-error-close").click();
  assert.equal(document.getElementById("risk-operation-alert").hidden, true);
  assert.deepEqual(presenter.current(), before);
  assert.equal(presenter.current().requiresReconciliation, true);
  assert.equal(checks, 0); assert.equal(queries, 0);
});

test("buttons invoke only their explicit callback with sanitized current information", () => {
  const document = documentFixture(), checks = [], queries = [];
  const presenter = createPresenter({ document, onCheck: info => checks.push(info), onQuery: info => queries.push(info) });
  presenter.show({ code: "SERVER_RESULT_UNKNOWN", task_id: "task-one", operation: "风险检查", method: "POST", message: "private" });
  document.getElementById("operation-error-check").click();
  assert.equal(checks.length, 1); assert.equal(queries.length, 0);
  document.getElementById("operation-error-query").click();
  assert.equal(queries.length, 1);
  assert.equal(queries[0].task_id, "task-one");
  assert.equal("message" in queries[0], false);
  assert.equal(document.getElementById("risk-operation-alert").hidden, false);
  presenter.hide();
  document.getElementById("operation-error-check").click();
  document.getElementById("operation-error-query").click();
  assert.equal(checks.length, 1); assert.equal(queries.length, 1);
});

test("query is visible only when a valid task and reconciliation are both present", () => {
  const document = documentFixture(), calls = [];
  const presenter = createPresenter({ document, onQuery: info => calls.push(info) });
  presenter.show({ code: "NETWORK_OFFLINE", sent: false, task_id: "task-one" });
  assert.equal(document.getElementById("operation-error-query").hidden, true);
  document.getElementById("operation-error-query").click();
  assert.equal(calls.length, 0);
  presenter.show({ code: "SERVER_RESULT_UNKNOWN" });
  assert.equal(document.getElementById("operation-error-query").hidden, true);
  presenter.show({ code: "SERVER_RESULT_UNKNOWN", task_id: "task-one" });
  assert.equal(document.getElementById("operation-error-query").hidden, false);
});

test("current returns a defensive copy and repeated creation does not duplicate the panel", () => {
  const document = documentFixture(), presenter = createPresenter({ document });
  presenter.show({ code: "SERVER_RESULT_UNKNOWN", task_id: "task-original" });
  const copy = presenter.current(); copy.task_id = "task-mutated"; copy.requiresReconciliation = false;
  assert.equal(presenter.current().task_id, "task-original");
  assert.equal(presenter.current().requiresReconciliation, true);
  let checks = 0;
  const same = createPresenter({ document, onCheck: () => { checks++; } });
  assert.equal(same, presenter);
  assert.equal(document.body.children.length, 1);
  document.getElementById("operation-error-check").click();
  assert.equal(checks, 1);
});

test("callback failure cannot hide or clear an unresolved operation", () => {
  const document = documentFixture();
  const presenter = createPresenter({ document, onCheck: () => { throw new Error("private callback failure"); } });
  presenter.show({ code: "SERVER_RESULT_UNKNOWN", task_id: "task-safe" });
  assert.doesNotThrow(() => document.getElementById("operation-error-check").click());
  assert.equal(document.getElementById("risk-operation-alert").hidden, false);
  assert.equal(presenter.current().requiresReconciliation, true);
});

test("missing document or invalid callbacks fail before creating a panel", () => {
  assert.throws(() => createPresenter({ document: {} }), TypeError);
  const document = documentFixture();
  assert.throws(() => createPresenter({ document, onCheck: true }), TypeError);
  assert.equal(document.body.children.length, 0);
});
