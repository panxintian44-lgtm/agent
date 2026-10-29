import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectId = "appgprj_6ac9a87727948191a202fedf09841f82";
const baselineHash = "3063fd721e5d49d69a9fa29de1aab932564b8f9dd4b291fb9c58eaa12410ae5f";
const digest = value => createHash("sha256").update(value).digest("hex");
function replaceOnce(source, before, after) {
  if (!source.includes(before) || source.indexOf(before) !== source.lastIndexOf(before)) throw new Error("The current Site source changed; review the integration anchors before installing.");
  return source.replace(before, after);
}
export function patchAsset(route, source) {
  source = source.replace(/\r\n?/g, "\n");
  if (route === "/risk") {
    source = replaceOnce(source, '<script src="/risk/app.js" defer>', '<link rel="stylesheet" href="/risk/connection.css"><script src="/risk/network.js" defer></script><script src="/risk/feedback.js" defer></script><script src="/risk/connection.js" defer></script><script src="/risk/app.js" defer>');
    return source;
  }
  const daily = route.endsWith("daily.js");
  const failureHandler = daily ? 'catch (error) { tell(`${error.message}${error.code ? `（${error.code}）` : ""}`, true); }' : 'catch (error) { notice(error.message, true); }';
  source = replaceOnce(source, failureHandler, `catch (error) { ${daily ? "tell" : "notice"}(window.RiskConnection.reportUiError(), true); }`);
  const start = source.indexOf("async function api(route, data) {");
  const end = source.indexOf(daily ? "\n  function confirmedInputs()" : "\nasync function action(", start);
  if (start < 0 || end < start || !source.slice(start, end).includes("await fetch(")) throw new Error("The original request helper changed; stop rather than overwrite it.");
  source = source.slice(0, start) + `async function api(route, data) { return window.RiskConnection.request(route, data, { csrf: ${daily ? "session?.csrf" : "csrf"} }); }\n` + source.slice(end);
  source = replaceOnce(source, "function renderButtons() {", "function renderButtons() { renderBaseButtons(); window.RiskConnection.enforceButtons(); }\n" + (daily ? "  " : "") + "function renderBaseButtons() {");
  const listeners = `\n${daily ? "  " : ""}window.addEventListener("risk:connection", renderButtons);\n` +
    `${daily ? "  " : ""}window.addEventListener("risk:reconciled", event => { if (${daily ? 'event.detail.kind === "DAILY_CASHFLOW"' : 'event.detail.kind !== "DAILY_CASHFLOW"'}) { ${daily ? "task = event.detail; execution = task.execution; render(); void refreshAudit().catch(error => tell(error.message, true));" : "record = event.detail; lastExecution = record.execution; render(); void audit().catch(error => notice(error.message, true));"} } });\n`;
  if (daily) source = replaceOnce(source, "})();", listeners + "})();");
  else source += listeners;
  return source;
}

export async function installSite(directory) {
  const root = path.resolve(directory), manifest = JSON.parse(fs.readFileSync(path.join(root, ".openai/hosting.json"), "utf8"));
  if (manifest.project_id !== projectId) throw new Error("This installer only updates the selected existing workbench Site.");
  const server = path.join(root, "dist/server"), entry = path.join(server, "index.js"), base = path.join(server, "index-base.js");
  const original = fs.readFileSync(fs.existsSync(base) ? base : entry);
  if (digest(original) !== baselineHash) throw new Error("The deployed baseline differs from Site version 10; inspect the newer source before updating.");
  if (!fs.existsSync(base)) fs.writeFileSync(base, original, { flag: "wx" });
  const worker = (await import(pathToFileURL(base).href)).default, assets = {};
  for (const route of ["/risk", "/risk/app.js", "/risk/daily.js"]) {
    const response = await worker.fetch(new Request("https://synthetic.invalid" + route), {});
    if (!response.ok) throw new Error("The Site baseline asset could not be read.");
    assets[route] = { body: patchAsset(route, await response.text()), type: route === "/risk" ? "text/html; charset=utf-8" : "text/javascript; charset=utf-8" };
  }
  for (const file of ["network.js", "feedback.js", "connection.js", "connection.css"]) assets["/risk/" + file] = { body: fs.readFileSync(path.join(moduleDirectory, file), "utf8"), type: file.endsWith("css") ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8" };
  const wrapper = `import base from "./index-base.js";
import assets from "./network-assets.mjs";
import { createHealthMonitor } from "./network-health.mjs";
const inspect = createHealthMonitor();
const headers = { "Cache-Control":"no-store", "X-Content-Type-Options":"nosniff" };
export default { async fetch(request, env, ctx) {
  const url = new URL(request.url);
  if (url.pathname === "/api/safety/health") {
    if (request.method !== "GET") return Response.json({error:{code:"METHOD_NOT_ALLOWED",message:"健康检查只接受读取。"}}, {status:405,headers:{...headers,Allow:"GET"}});
    if (request.headers.get("Origin") && request.headers.get("Origin") !== url.origin || request.headers.get("Sec-Fetch-Site") === "cross-site") return Response.json({error:{code:"ORIGIN_MISMATCH",message:"拒绝跨来源请求。"}}, {status:403,headers});
    try { return Response.json(await inspect(env), {headers}); }
    catch { return Response.json({error:{code:"HEALTH_UNAVAILABLE",message:"暂时无法核实服务状态。"},execution_allowed:false}, {status:503,headers}); }
  }
  const asset = assets[url.pathname === "/risk/" ? "/risk" : url.pathname];
  if (asset && ["GET","HEAD"].includes(request.method)) return new Response(request.method === "HEAD" ? null : asset.body, {headers:{...headers,"Content-Type":asset.type,"Content-Security-Policy":"default-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"}});
  return base.fetch(request, env, ctx);
} };
`;
  const provenanceFile = path.join(root, "network-resilience-provenance.json");
  const previous = fs.existsSync(provenanceFile) ? JSON.parse(fs.readFileSync(provenanceFile, "utf8")) : {};
  const currentEntry = digest(fs.readFileSync(entry));
  if (![baselineHash, previous.entry_sha256, digest(wrapper)].includes(currentEntry)) throw new Error("The Site entry was changed after the last known build; preserve it and review the diff first.");
  fs.writeFileSync(path.join(server, "network-assets.mjs"), "export default " + JSON.stringify(assets) + ";\n");
  fs.copyFileSync(path.join(moduleDirectory, "health.mjs"), path.join(server, "network-health.mjs"));
  fs.writeFileSync(entry, wrapper);
  const provenance = { project_id: projectId, baseline_site_version: 10, baseline_sha256: baselineHash, mutation_handlers_changed: false,
    entry_sha256: digest(wrapper),
    files: Object.fromEntries(["network.js", "feedback.js", "connection.js", "connection.css", "health.mjs", "install-site.mjs"].map(file => [file, digest(fs.readFileSync(path.join(moduleDirectory, file)))])) };
  fs.writeFileSync(path.join(root, "network-resilience-provenance.json"), JSON.stringify(provenance, null, 2) + "\n");
  return provenance;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw new Error("Usage: node install-site.mjs <existing-site-checkout>");
  console.log(JSON.stringify(await installSite(process.argv[2]), null, 2));
}
