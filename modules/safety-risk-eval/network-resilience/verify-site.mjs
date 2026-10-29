import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
const root = path.resolve(process.argv[2] || "");
if (!process.argv[2]) throw new Error("Provide the prepared existing Site checkout.");
const original = (await import(pathToFileURL(path.join(root, "dist/server/index-base.js")).href)).default;
let candidate;
let probes = 0, queries = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  assert.equal(url, "https://personal-ai-fund-manager-core-agent.realchenchenluo.workers.dev/health");
  assert.equal(options.method, "GET"); probes++;
  return Response.json({ status: "ok", service: "core-agent", contract_version: "investment-agent.v1", model: { configured: true } });
};
const env = { DB: { prepare(sql) { assert.equal(sql, "SELECT 1 AS ok"); queries++; return { first: async () => ({ ok: 1 }) }; } } };
const rows = [];
try {
  candidate = (await import(pathToFileURL(path.join(root, "dist/server/index.js")).href)).default;
  for (const route of ["/risk", "/risk/app.js", "/risk/daily.js", "/risk/network.js", "/risk/feedback.js", "/risk/connection.js", "/risk/connection.css"]) {
    const response = await candidate.fetch(new Request("https://synthetic.invalid" + route), env);
    assert.equal(response.status, 200); const text = await response.text();
    if (route.endsWith(".js")) new vm.Script(text);
    if (route === "/risk") assert.ok(text.indexOf("/risk/network.js") < text.indexOf("/risk/feedback.js") && text.indexOf("/risk/feedback.js") < text.indexOf("/risk/connection.js") && text.indexOf("/risk/connection.js") < text.indexOf("/risk/app.js"));
    if (route.endsWith("daily.js")) { assert.ok(text.includes("function confirmedInputs()")); assert.ok(text.includes("function acceptableReasons()")); }
    if (["/risk/app.js", "/risk/daily.js"].includes(route)) { assert.ok(text.includes("RiskConnection.request")); assert.ok(text.includes("RiskConnection.enforceButtons")); assert.ok(text.includes("RiskConnection.reportUiError")); assert.ok(!text.includes("await fetch(route")); }
    rows.push({ route, result: "PASS" });
  }
  const response = await candidate.fetch(new Request("https://synthetic.invalid/api/safety/health"), env);
  const health = await response.json(); assert.equal(response.status, 200); assert.equal(health.overall, "UP"); assert.equal(health.business_acceptance, "NOT_VERIFIED");
  assert.equal(response.headers.has("Set-Cookie"), false); assert.equal(queries, 1); assert.equal(probes, 1);
  rows.push({ route: "/api/safety/health", result: "PASS", no_session_created: true, model_inference_calls: 0 });
  for (const [method, headers, expected] of [["POST", {}, 405], ["GET", { Origin: "https://untrusted.invalid" }, 403]]) {
    const denied = await candidate.fetch(new Request("https://synthetic.invalid/api/safety/health", { method, headers }), env);
    assert.equal(denied.status, expected); assert.equal(queries, 1);
    rows.push({ route: "/api/safety/health", method, expected_status: expected, result: "PASS" });
  }
  for (const route of ["/investment", "/merchant"]) {
    const [before, after] = await Promise.all([original.fetch(new Request("https://synthetic.invalid" + route), env), candidate.fetch(new Request("https://synthetic.invalid" + route), env)]);
    assert.equal(before.status, after.status); assert.equal(await before.text(), await after.text());
    assert.equal(before.headers.get("Location"), after.headers.get("Location")); rows.push({ route, result: "UNCHANGED" });
  }
  const result = { verification: "PREPARED_SITE_HANDLER_WITH_HEALTH_TEST_DOUBLES", passed: rows.length, failed: 0, real_model_calls: 0, business_acceptance: "NOT_VERIFIED", checks: rows };
  if (process.argv[3]) fs.writeFileSync(path.resolve(process.argv[3]), JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
  console.log(JSON.stringify(result, null, 2));
} finally { globalThis.fetch = originalFetch; }
