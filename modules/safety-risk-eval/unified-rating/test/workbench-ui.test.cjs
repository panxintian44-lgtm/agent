"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// This is a DOM test double, not a browser or a live service integration.
class Element {
  constructor(tag) {
    this.tagName = tag; this.children = []; this.attributes = {}; this.dataset = {};
    this.className = ""; this.id = ""; this.disabled = false; this._text = "";
  }
  append(...elements) { this.children.push(...elements); }
  prepend(...elements) { this.children.unshift(...elements); }
  replaceChildren(...elements) { this._text = ""; this.children = [...elements]; }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  get firstChild() { return this.children[0] || null; }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(element => element.textContent).join("\n"); }
  set innerHTML(_) { throw new Error("Risk messages must be rendered as text."); }
}

const writeIds = ["daily-execute", "daily-repeat", "execute", "repeat"];
const dependentIds = ["daily-model-review", "daily-approve", "daily-whole-plan"];
function find(root, predicate) {
  if (predicate(root)) return root;
  for (const child of root.children) { const matched = find(child, predicate); if (matched) return matched; }
  return null;
}

function fixture({ modelAvailable = true, initiallyDisabled = false, includeConnection = true } = {}) {
  const body = new Element("body"), main = new Element("main"), results = new Element("div");
  results.className = "daily-results"; body.append(main); main.append(results);
  const buttons = Object.fromEntries([...writeIds, ...dependentIds].map(id => {
    const element = new Element(id === "daily-whole-plan" ? "input" : "button");
    element.id = id; element.disabled = initiallyDisabled; main.append(element); return [id, element];
  }));
  const document = {
    createElement: tag => new Element(tag),
    getElementById: id => find(body, element => element.id === id),
    querySelector: selector => selector === "main" ? main : selector.startsWith(".") ? find(body, element => element.className.split(/\s+/).includes(selector.slice(1))) : null
  };
  const listeners = new Map(), reads = [];
  const window = { addEventListener(name, listener) { listeners.set(name, listener); } };
  if (includeConnection) window.RiskConnection = { modelAvailable: () => modelAvailable };
  const fetch = async (url, options) => {
    reads.push({ url, options });
    assert.equal(url, "/api/safety/unified-policy");
    return { ok: true, async json() { return { contract_version: "unified-workbench-info.v1", permission: { decision: "ALLOW" }, capabilities: [] }; } };
  };
  const sandbox = vm.createContext({ window, document, fetch });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../workbench.js"), "utf8"), sandbox);
  return {
    api: window.UnifiedRisk, buttons, document, body, reads,
    panel: () => document.querySelector(".unified-grade"),
    grade: () => document.querySelector(".unified-grade-value").textContent,
    // The existing form owns enabled states; this simulates its base renderer.
    baseStates(disabled = false) { for (const button of Object.values(buttons)) button.disabled = disabled; },
    setModelAvailable(value) { modelAvailable = value; },
    connectionEvent() { listeners.get("risk:connection")?.(); }
  };
}

function record({ validation = "VALID", decision = "ALLOW", band = "LOW", label = "低", coverage = "FULL" } = {}) {
  return {
    current_validation: { validation_status: validation, risk_decision: decision, validation_errors: validation === "VALID" ? [] : [{ code: "RESULT_STATUS_INCONSISTENT", message_zh: "检查状态与原因不一致，请重新核对。" }] },
    unified_assessment: {
      validation_status: "VALID", business_risk_band: band, label_zh: label, coverage, risk_decision: decision,
      source_risk_check_id: "synthetic-check-1", policy_version: "risk-policy.v1.1", source_policy_version: "daily-cashflow-policy.v1.0",
      scope: "用户确认的虚构单资金池。", unknown_items: []
    },
    unified_permission: { decision: "DENY", message_zh: "模拟写入未接通，保持关闭。" }
  };
}

function allDisabled(f, ids) { for (const id of ids) assert.equal(f.buttons[id].disabled, true, id); }

test("without a current task, model, confirmation and execution remain disabled", () => {
  const f = fixture();
  allDisabled(f, [...dependentIds, ...writeIds]);
  f.baseStates(false); f.api.render(null);
  assert.equal(f.grade(), "未知");
  allDisabled(f, [...dependentIds, ...writeIds]);
  assert.equal(f.reads.length, 1);
  assert.equal(f.reads[0].url, "/api/safety/unified-policy");
});

for (const validation of ["INVALID", "UNSUPPORTED"]) {
  test(`${validation} current validation disables all dependent actions`, () => {
    const f = fixture(); f.baseStates(false);
    const input = record({ validation, band: "HIGH", label: "高" }), original = structuredClone(input);
    f.api.render(input);
    assert.match(f.grade(), /未知/);
    assert.equal(f.panel().dataset.band, "UNKNOWN");
    assert.match(f.panel().textContent, /不能确认计划或继续模型复核/);
    assert.match(f.panel().textContent, /检查状态与原因不一致/);
    allDisabled(f, [...dependentIds, ...writeIds]);
    assert.deepEqual(input, original);
  });
}

test("a validated ERROR retains its grade while preventing model review and execution", () => {
  const f = fixture();
  f.baseStates(true); f.buttons["daily-model-review"].disabled = false;
  f.api.render(record({ decision: "ERROR", band: "HIGH", label: "高", coverage: "PARTIAL" }));
  assert.equal(f.grade(), "高 · HIGH");
  assert.match(f.panel().textContent, /必要检查发生异常，模型复核暂停/);
  allDisabled(f, [...dependentIds, ...writeIds]);
});

test("VALID ALLOW preserves existing form states and never grants execution authority", () => {
  const f = fixture(); f.baseStates(false);
  f.api.render(record());
  assert.equal(f.grade(), "低 · LOW");
  for (const id of dependentIds) assert.equal(f.buttons[id].disabled, false, id);
  allDisabled(f, writeIds);

  f.baseStates(true); f.api.render(record());
  allDisabled(f, [...dependentIds, ...writeIds]);
  f.connectionEvent();
  allDisabled(f, [...dependentIds, ...writeIds]);
});

test("changing data marks the old grade historical and blocks all dependent actions", () => {
  const f = fixture(); f.baseStates(false); f.api.render(record());
  assert.equal(f.grade(), "低 · LOW");
  f.api.invalidate();
  assert.equal(f.panel().dataset.stale, "true");
  assert.equal(f.grade(), "低 · LOW");
  assert.match(f.panel().textContent, /保留上一次评级，不能代表新方案/);
  allDisabled(f, [...dependentIds, ...writeIds]);

  f.baseStates(false); f.api.enforce();
  allDisabled(f, [...dependentIds, ...writeIds]);
});

test("invalid current results cannot inherit a historical LOW grade", () => {
  const f = fixture(); f.baseStates(false);
  const input = record({ validation: "INVALID" });
  input.unified_assessment.policy_version = "risk-policy.v1.0";
  f.api.render(input);
  assert.match(f.grade(), /未知/);
  assert.equal(f.panel().dataset.band, "UNKNOWN");
  assert.match(f.panel().textContent, /历史评级仍保留：低（risk-policy\.v1\.0）/);
  assert.match(f.panel().textContent, /该历史结果不能用于本次操作/);
  allDisabled(f, [...dependentIds, ...writeIds]);
});

test("network model availability independently prevents model review", () => {
  const f = fixture({ modelAvailable: false }); f.baseStates(false);
  f.api.render(record());
  assert.equal(f.grade(), "低 · LOW");
  assert.equal(f.buttons["daily-model-review"].disabled, true);
  assert.equal(f.buttons["daily-approve"].disabled, false);
  allDisabled(f, writeIds);

  f.setModelAvailable(true); f.connectionEvent();
  assert.equal(f.buttons["daily-model-review"].disabled, true, "connection restoration must not grant a form action");
  f.baseStates(false); f.api.enforce();
  assert.equal(f.buttons["daily-model-review"].disabled, false);
});

test("missing network capability is unknown rather than assumed model availability", () => {
  const f = fixture({ includeConnection: false }); f.baseStates(false);
  f.api.render(record());
  assert.equal(f.buttons["daily-model-review"].disabled, true);
  allDisabled(f, writeIds);
});

test("missing assessment cannot inherit VALID current metadata or enabled controls", () => {
  const f=fixture(); f.baseStates(false);
  const input=record(); input.unified_assessment=null; f.api.render(input);
  assert.equal(f.grade(),"未知"); allDisabled(f,[...dependentIds,...writeIds]);
});
