"use strict";
// Synthetic HTTP UI verification only. No live model or callback is invoked.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '../../..');
const staticRoot = path.join(root, 'qiqi/web/static');
const evidenceDir = path.join(__dirname, '.runtime', 'ui-evidence');
fs.mkdirSync(evidenceDir, { recursive: true });
const boot = { user: {name: '虚构用户', risk_tolerance: '待确认', investment_horizon: '待确认'},
  meta: { engine: { label: 'MOCK HTTP / no model call' }, data_tag: 'MOCK', disclaimer: 'MOCK UI validation' },
  portfolio: {positions: [], cash: 10000, total_assets: 10000, total_value: 0, sector_allocation: [], date: '2026-10-21'},
  health: {winning_positions: 0, losing_positions: 0, top_gain: {}, top_loss: {}},
  brief: {lines: [], disclaimer: 'MOCK'}, news: [], approvals: [], tier_matrix: [], breaker: {locked: false, consecutive_failures: 0} };
let outcome = 'BLOCK', submitted, deferred;
function reply() { return { engine: 'risk-conversation', conversation_mode: 'READ_ONLY_CONVERSATION',
  decision_source: 'model', model_status: 'live', execution_allowed: false, executed: false, queued: false,
  run_id: 'MOCK-run', task_id: 'MOCK-task', audit_id: 'MOCK-audit', execution_state: 'blocked',
  risk_callback: {status:'RECORDED'}, model_raw: 'MOCK模型实际说明 <script>window.injected = true</script>',
  risk_advice: { decision: outcome, summary: '这笔安排会挤占房租，请先减少本次投入。', program_generated: true,
    execution_allowed: false, metrics: { free_before_minor:600000, action_total_minor:800000, projected_free_after_minor:-200000, shortfall_minor:200000 },
    input_confirmation:{facts_confirmed:true,purposes_confirmed:true},
    reasons: [{code:'PROTECTED_PURPOSE_CONFLICT', message_zh:'本次投入会影响已确认的房租安排。'}],
    next_actions:['先保留房租，再决定投入金额。'], protected_purposes:[{label:'房租',reserved_now_minor:300000,remaining_due_minor:300000,due_at:'2026-11-20'}] } }; }
const server = http.createServer(async (req,res) => {
  const url = new URL(req.url,'http://localhost');
  if(url.pathname.startsWith('/api/')) {
    let data = {};
    if(url.pathname === '/api/bootstrap') data = boot;
    if(url.pathname === '/api/risk-conversation/status') data = { configured: true };
    if(url.pathname === '/api/scenarios/boot') data = {scenarios:[]};
    if(url.pathname === '/api/scenarios/pending') data = {pending:[]};
    if(url.pathname === '/api/audit') data = {entries:[]};
    if(url.pathname === '/api/review') {
      const chunks=[]; for await(const chunk of req) chunks.push(chunk);
      submitted = JSON.parse(Buffer.concat(chunks));
      if(outcome === 'DELAY') await new Promise(resolve=>deferred=resolve);
      data = reply();
      if(outcome === 'UNKNOWN') { data.risk_advice.decision='BLOCK';data.risk_callback.status='UNKNOWN'; }
      if(outcome === 'ERROR') { data.decision_source='unavailable';data.model_status='unavailable';data.model_raw=null;data.error='模型调用失败，未自动回退';res.statusCode=503; }
    }
    res.setHeader('Content-Type','application/json'); res.end(JSON.stringify(data)); return;
  }
  const file = url.pathname==='/' ? 'index.html' : url.pathname.replace(/^\/static\//,'');
  const target = path.resolve(staticRoot,file);
  if(!target.startsWith(staticRoot+path.sep)||!fs.existsSync(target)){res.statusCode=404;res.end();return;}
  res.setHeader('Content-Type', target.endsWith('.js')?'text/javascript':target.endsWith('.css')?'text/css':'text/html');
  res.end(fs.readFileSync(target));
});
(async()=>{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base='http://127.0.0.1:'+server.address().port;
 const browser = await chromium.launch({headless:true,executablePath:'C:/Users/lenovo/AppData/Local/Google/Chrome/Application/chrome.exe'});
 const results=[];
 try {
  for(const width of [375,1440]) {
   const page=await browser.newPage({viewport:{width,height:960}}), errors=[];
   page.on('pageerror',error=>errors.push(error.message));
   await page.goto(base,{waitUntil:'networkidle'});
   await page.locator('#daily-finance-form summary').click();
   await page.locator('#daily-finance-enable').check();
   await page.locator('#daily-finance-example').click();
   assert.equal(await page.locator('#daily-facts-confirmed').isChecked(),false);
   await page.locator('#daily-facts-confirmed').check();
   await page.locator('#daily-purpose-confirmed').check();
   await page.locator('#nl-question').fill('我想投入8000元，但是下月还要交房租。');
   await page.locator('#btn-review').click();
   await page.locator('#agent-status').filter({hasText:'已阻止'}).waitFor();
   assert.equal(submitted.daily_finance_yuan.cash_yuan,'10000');
   assert.equal(submitted.daily_finance_yuan.fees_yuan,'0');
   assert.equal(submitted.daily_finance_yuan.facts_confirmed,true);
   assert.equal(submitted.daily_finance_yuan.purpose_confirmed,true);
   assert.match(await page.locator('#rec-area').innerText(),/¥2000\.00/);
   assert.equal(await page.locator('#btn-confirm').count(),0);
   assert.equal(await page.locator('#card-approvals').isVisible(),false);
   assert.equal(await page.locator('#rec-area details[open]').count(),0);
   assert.equal(await page.evaluate(()=>window.injected),undefined);
   assert.equal(await page.evaluate(()=>document.scrollingElement.scrollWidth>document.scrollingElement.clientWidth),false);
   const firstKey = submitted.idempotency_key;
   await page.locator('#btn-review').click();
   await page.waitForFunction(()=>!document.querySelector('#btn-review').disabled);
   assert.equal(submitted.idempotency_key,firstKey);
   await page.screenshot({path:path.join(evidenceDir,`conversation-${width}.png`),fullPage:true});
   await page.locator('#daily-amount').fill('7000');
   assert.equal(await page.locator('#daily-facts-confirmed').isChecked(),false);
   assert.equal(await page.locator('#daily-purpose-confirmed').isChecked(),false);
   assert.match(await page.locator('#rec-area').innerText(),/输入已修改/);
   outcome='UNKNOWN';
   await page.locator('#btn-review').click();
   await page.locator('#agent-status').filter({hasText:'回写结果待核查'}).waitFor();
   assert.notEqual(submitted.idempotency_key,firstKey);
   assert.match(await page.locator('#rec-area').innerText(),/暂不重发或执行/);
   outcome='ERROR';
   await page.locator('#btn-review').click();
   await page.locator('#agent-status').filter({hasText:'失败'}).waitFor();
   assert.equal(await page.locator('#btn-confirm').count(),0);
   await page.locator('#rec-area summary').filter({hasText:'模型说明'}).click();
   assert.match(await page.locator('#rec-area').innerText(),/没有可展示的模型原文/);
   outcome='DELAY';
   await page.locator('#btn-review').click();
   while(!deferred) await new Promise(resolve=>setTimeout(resolve,10));
   await page.locator('#nl-question').fill('输入已变更，旧返回不能采用');
   outcome='BLOCK';deferred();deferred=null;
   await page.waitForFunction(()=>!document.querySelector('#btn-review').disabled);
   assert.match(await page.locator('#rec-area').innerText(),/输入已修改/);
   assert.deepEqual(errors,[]);
   results.push({width,result:'PASS',cases:['string amounts','separate confirmations','read-only block','closed audit and model details','XSS escaped','stale response ignored','real failure not success'],overflow:false});
   await page.close();outcome='BLOCK';
  }
  fs.writeFileSync(path.join(evidenceDir,'conversation-ui-result.json'),JSON.stringify({modelCalls:0,mode:'MOCK_HTTP_UI',results},null,2));
  console.log(JSON.stringify({modelCalls:0,results},null,2));
 } finally {await browser.close();server.close();}
})().catch(error=>{console.error(error);server.close();process.exitCode=1;});
