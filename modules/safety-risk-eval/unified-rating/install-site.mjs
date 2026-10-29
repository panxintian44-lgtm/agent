import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
const projectId = "appgprj_6ac9a87727948191a202fedf09841f82";
const hash = x => createHash("sha256").update(x).digest("hex");
const normalize = x => x.replace(/\r\n/g,"\n");
const baselines = {13: {
  "index.js":"368b2095397ceb64032ae03799bfd5180902b75b64a76b9752da6d254bbda8db",
  "index-unified-base.js":"86d3596268b48bfd522801c7a1b8b14bd6b0329f36bfc0543517ac1ba4dacf2f",
  "network-assets.mjs":"b60a53c740670dc5d638e7a02d774be9e7dbc5505498fb50eaca2f1cc831684b"
}, 14: {
  "index.js":"368b2095397ceb64032ae03799bfd5180902b75b64a76b9752da6d254bbda8db",
  "index-unified-base.js":"7601c2acbc5d78c2e6c620f2c1cd12a950d588b0f231e293e6dbdd481be4b9e2",
  "network-assets.mjs":"2c5d2eaefdfd8cbc7677ceef3599fde097f9bd319b36ed973491b5c2f06137c3"
}};
function once(source,before,after) {
  if(source.indexOf(before)<0 || source.indexOf(before)!==source.lastIndexOf(before)) throw new Error("Reviewed source anchor changed; inspect the newer Site before installing.");
  return source.replace(before,after);
}

// Resolve the pure evaluator dependency graph at build time. All imports are
// static ESM; no eval, runtime require or Node builtin is used in the evaluators.
function compileEvaluators() {
  const outputs=new Map(), names=new Map(), sources=new Map();
  const docs=path.resolve(here,"../../../docs/safety-risk-eval");
  function emit(file) {
    file=path.resolve(file); const name=path.basename(file).replace(/\.cjs$/,".mjs");
    if(names.has(name) && names.get(name)!==file) throw new Error("Evaluator output name collision.");
    if(outputs.has(name)) return name;
    if(!file.startsWith(here+path.sep) || !file.endsWith(".cjs")) throw new Error("Unexpected evaluator module.");
    names.set(name,file); sources.set(path.relative(here,file),hash(fs.readFileSync(file)));
    let source=normalize(fs.readFileSync(file,"utf8")), imports=[], counter=0;
    const exports=/module\.exports\s*=\s*\{\s*([A-Za-z0-9_,\s]+)\s*\};/.exec(source);
    if(!exports) throw new Error("Evaluator exports must be explicit identifiers.");
    source=source.replace(/require\(["']([^"']+)["']\)/g,(_,request)=>{
      if(!request.startsWith(".")) throw new Error("External evaluator dependency is forbidden.");
      const resolved=path.resolve(path.dirname(file),request);
      if(resolved.endsWith(".json")) {
        if(!resolved.startsWith(here+path.sep) && !resolved.startsWith(docs+path.sep)) throw new Error("Unexpected evaluator data path.");
        sources.set(path.relative(here,resolved),hash(fs.readFileSync(resolved)));
        return JSON.stringify(JSON.parse(fs.readFileSync(resolved,"utf8")));
      }
      const target=emit(resolved), alias="dependency"+counter++;
      imports.push(`import * as ${alias} from "./${target}";`); return alias;
    });
    source=source.replace(exports[0],`export const exported = { ${exports[1]} };\nexport { ${exports[1]} };`);
    if(/\brequire\(/.test(source)) throw new Error("Unresolved evaluator dependency.");
    outputs.set(name,imports.join("\n")+"\n"+source); return name;
  }
  emit(path.join(here,"assessment.cjs"));emit(path.join(here,"permission.cjs"));
  return {outputs,sources};
}

export async function installSite(directory) {
  const root=path.resolve(directory), manifest=JSON.parse(fs.readFileSync(path.join(root,".openai/hosting.json")));
  if(manifest.project_id!==projectId) throw new Error("Wrong Site selected.");
  const server=path.join(root,"dist/server"), content={};
  for(const file of Object.keys(baselines[13])) {
    content[file]=normalize(fs.readFileSync(path.join(server,file),"utf8"));
  }
  const baselineVersion=Object.keys(baselines).find(version=>Object.entries(baselines[version]).every(([file,digest])=>hash(content[file])===digest));
  if(!baselineVersion) throw new Error("The reviewed version 13/14 baseline changed; preserve it and inspect before updating.");
  const baseline=baselines[baselineVersion];
  const compiled=compileEvaluators(), outputs=compiled.outputs;
  let base=content["index-unified-base.js"];
  if(baselineVersion==="13") {
  base=once(base,'      let result;',`      // Revalidate stored evidence before confirmation or model access.
      if (request.method === "POST" && ["/api/safety/daily/model-review", "/api/safety/confirm"].includes(url.pathname)) {
        const selected = gatewayFor(payload.task_id), current = selected.inspect(payload.task_id, actor);
        if (current.kind === "DAILY_CASHFLOW") {
          const checked = enrichDailyRecord(current).current_validation;
          if (checked.validation_status !== "VALID" || checked.risk_decision === "ERROR") {
            selected.event("UNIFIED_RESULT_REJECTED", current, { current_validation: checked, execution_allowed: false });
            await store.flush();
            return json({ decision: "ERROR", task_id: payload.task_id, current_validation: checked, execution_allowed: false,
              error: { code: checked.validation_status === "VALID" ? "RISK_CHECK_FAILED" : "RISK_RESULT_INVALID", message: "风险结果未通过必要检查，模型复核和计划确认已暂停。请修复资料并重新检查。" } }, 503, session);
          }
        }
      }
      let result;`);
  base=once(base,'      result = enrichDailyRecord(result);',`      result = enrichDailyRecord(result, { events: store.events, newCheck: request.method === "POST" && ["/api/safety/daily/tasks", "/api/safety/daily/revise"].includes(url.pathname) });`);
  }
  // Confirmation creates a new check. Persist its sidecar alongside that new
  // check without recalculating or rewriting the previous signed audit event.
  base=once(base,'        result = gatewayFor(payload.task_id).confirm(payload.task_id, actor, payload);',`        const selected = gatewayFor(payload.task_id);
        result = selected.confirm(payload.task_id, actor, payload);
        const rechecked = selected.inspect(payload.task_id, actor);
        if (rechecked.kind === "DAILY_CASHFLOW") {
          const enriched = enrichDailyRecord(rechecked, { newCheck: true });
          selected.event("UNIFIED_ASSESSMENT_RECORDED", rechecked, { unified_assessment: enriched.unified_assessment,
            permission: enriched.unified_permission, assessment_stage: "CONFIRMATION_RECHECK", execution_allowed: false });
        }`);
  outputs.set("index-unified-base.js",base);
  outputs.set("unified-bridge.mjs",fs.readFileSync(path.join(here,"site-bridge.mjs"),"utf8"));
  const assets=structuredClone((await import(pathToFileURL(path.join(server,"network-assets.mjs")).href)).default);
  if(!assets["/risk/daily.js"].body.includes("window.UnifiedRisk.render(task);")) throw new Error("Daily UI integration anchor missing.");
  if(baselineVersion==="13") assets["/risk/daily.js"].body=once(assets["/risk/daily.js"].body,"window.UnifiedRisk.render(task);","window.UnifiedRisk.render(task); if (dirty) window.UnifiedRisk.invalidate();");
  for(const [ext,type] of [["js","text/javascript"],["css","text/css"]]) assets["/risk/unified."+ext]={body:fs.readFileSync(path.join(here,"workbench."+ext),"utf8"),type:type+"; charset=utf-8"};
  if(baselineVersion==="13") {
  assets["/risk/daily.js"].body=once(assets["/risk/daily.js"].body,'UNIFIED_ASSESSMENT_RECORDED: "统一风险评级已记录",','UNIFIED_RESULT_REJECTED: "风险结果校验失败，已暂停后续操作", UNIFIED_ASSESSMENT_RECORDED: "统一风险评级已记录",');
  assets["/risk/connection.js"].body=once(assets["/risk/connection.js"].body,'window.RiskConnection = { request, enforceButtons, checkHealth, reportUiError };',
    'window.RiskConnection = { request, enforceButtons, checkHealth, reportUiError, modelAvailable: () => writable() && health?.services.core.status === "UP" && health?.services.core.model_configured === true };');
  }
  outputs.set("network-assets.mjs","export default "+JSON.stringify(assets)+";\n");
  const config=JSON.parse(fs.readFileSync(path.join(here,"runtime-config.v1.1.json")));
  outputs.set("runtime-config.mjs","export default "+JSON.stringify(config)+";\n");
  for(const [file,data] of outputs) fs.writeFileSync(path.join(server,file),data);
  const result={project_id:projectId,baseline_site_version:Number(baselineVersion),baseline_hashes:baseline,
    policy_version:config.risk_policy_version,permission_policy_version:config.permission_policy_version,
    entry_sha256:hash(content["index.js"]),unified_base_sha256:hash(base),
    implementation_scope:"DAILY_RESULT_VALIDATION_PERMISSION_REQUIREMENTS_AND_CLOSED_WRITES",
    all_capability_routes_integrated:false,team_joint_acceptance:false,real_model_calls:0,
    evaluator_sources:Object.fromEntries(compiled.sources),
    source_files:Object.fromEntries(["site-bridge.mjs","workbench.js","workbench.css","install-site.mjs"].map(f=>[f,hash(fs.readFileSync(path.join(here,f)))]))};
  fs.writeFileSync(path.join(root,"unified-risk-v1.1-provenance.json"),JSON.stringify(result,null,2)+"\n");
  return result;
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) console.log(JSON.stringify(await installSite(process.argv[2]),null,2));
