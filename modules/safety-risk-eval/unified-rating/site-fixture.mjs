// Test/preview adapter only. Never package this in the Worker deployment.
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
export function createD1(root) {
  const sqlite = new DatabaseSync(":memory:");
  for (const name of fs.readdirSync(path.join(root, "drizzle")).filter(x => x.endsWith(".sql")).sort()) sqlite.exec(fs.readFileSync(path.join(root, "drizzle", name), "utf8"));
  const adapter = { failWrites: false, modelBudgetWrites: 0,
    seedHistoricalAssessmentForTest(taskId, assessment) {
      for (const row of sqlite.prepare("SELECT session_id,payload FROM risk_demo_sessions").all()) {
        const saved=JSON.parse(row.payload);
        if (!saved.data.tasks[taskId]) continue;
        const event=saved.events.findLast(e=>e.event_type==="UNIFIED_ASSESSMENT_RECORDED" && e.task_id===taskId);
        event.unified_assessment=structuredClone(assessment);
        const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==="object"?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
        let previous="GENESIS";
        for (const e of saved.events) { e.previous_hash=previous; const {event_hash,...body}=e; e.event_hash=createHash("sha256").update(JSON.stringify(canonical(body))).digest("hex"); previous=e.event_hash; }
        sqlite.prepare("UPDATE risk_demo_sessions SET payload=? WHERE session_id=?").run(JSON.stringify(saved),row.session_id); return;
      }
      throw new Error("TEST_TASK_NOT_FOUND");
    },
    // Direct corruption injection for local verification, never an HTTP route.
    corruptTaskForTest(taskId, transform) {
      for (const row of sqlite.prepare("SELECT session_id,payload FROM risk_demo_sessions").all()) {
        const saved = JSON.parse(row.payload), task = saved.data.tasks[taskId];
        if (task) { transform(task); sqlite.prepare("UPDATE risk_demo_sessions SET payload=? WHERE session_id=?").run(JSON.stringify(saved), row.session_id); return; }
      }
      throw new Error("TEST_TASK_NOT_FOUND");
    }, prepare(sql) {
    let parameters = [];
    const query = () => { const statement = sqlite.prepare(sql); statement.setAllowBareNamedParameters(true); return statement; };
    const bindings = () => Object.fromEntries(parameters.map((value, i) => [String(i + 1), value]));
    const request = { bind(...values) { parameters = values; return request; },
      async first() { return query().get(bindings()) ?? null; },
      async run() { if (adapter.failWrites && /UPDATE.*SET payload/i.test(sql)) throw new Error("TEST_STORAGE_FAILED"); if (/INSERT INTO risk_model_budget/i.test(sql)) adapter.modelBudgetWrites++; const r = query().run(bindings()); return { success: true, meta: { changes: Number(r.changes) } }; } };
    return request;
  }, close() { sqlite.close(); } };
  return adapter;
}
export function dailyFixture(amount = 800000) {
  const now = new Date().toISOString(), future = new Date(Date.now() + 3 * 86400000).toISOString();
  return { contract_version: "daily-risk-workbench.v1", facts_confirmed: true, purposes_confirmed: true,
    snapshot: { currency: "CNY", cash_ledger_minor: 1000000, as_of: now,
      purposes: [{purpose_id:"rent",label:"虚构房租",reserved_now_minor:400000,remaining_due_minor:400000,due_at:future}],
      income_events: [], hard_floor: { state:"DISABLED_CONFIRMED", amount_minor:0 } },
    action: {type:"INVESTMENT",amount_minor:amount,fees_minor:0,at:now}, note:"虚构用例，没有真实资金。" };
}
