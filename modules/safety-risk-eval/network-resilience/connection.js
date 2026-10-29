"use strict";

(() => {
  const pendingKey = "risk-pending-network-operation.v1";
  const writeIds = ["create", "update", "approve", "reject", "revoke", "execute", "repeat", "run-attack", "run-model", "run-core", "repeat-core", "import-handoff",
    "daily-check", "daily-revise", "daily-approve", "daily-reject", "daily-revoke", "daily-execute", "daily-repeat", "daily-model-review"];
  let offline = navigator.onLine === false, health = null, lastCheck = 0, healthPending = null, pending = null, timer = null, connectionEpoch = 0;
  let lastFailureAt = 0, healthIncident = "";
  try { pending = JSON.parse(sessionStorage.getItem(pendingKey) || "null"); } catch { /* Storage may be unavailable; keep the in-memory guard. */ }
  if (pending && (typeof pending.route !== "string" || !pending.route.startsWith("/api/") || typeof pending.at !== "string")) pending = { route: "/api/unknown", at: new Date().toISOString() };
  const panel = document.createElement("section");
  panel.className = "connection-strip";
  panel.setAttribute("aria-labelledby", "connection-heading");
  panel.innerHTML = '<div class="connection-heading"><h2 id="connection-heading">连接与服务状态</h2><button type="button" id="connection-check">重新检查连接</button></div><p id="connection-summary" role="status" aria-live="polite" aria-atomic="true">正在核对服务状态，暂不提交新操作。</p><p id="connection-services"></p><p class="connection-footnote">本页可见时每 30 秒只读检查；切到后台暂停。连接恢复不会重发操作。</p><p id="connection-time" class="connection-footnote"></p><div id="connection-pending" hidden><p id="connection-pending-message" role="alert"></p><button type="button" id="connection-query">查询原任务状态</button><pre id="connection-query-result" hidden></pre></div>';
  document.querySelector("main").prepend(panel);
  const el = id => document.getElementById(id);
  const text = (id, value) => { if (el(id).textContent !== value) el(id).textContent = value; };
  const fresh = () => health && Date.now() - lastCheck < 75000;
  const writable = () => !offline && fresh() && health.services.workbench.status === "UP" && health.services.storage.status === "UP" && !pending;
  const feedback = window.RiskFeedback.createPresenter({ document, onCheck: () => { void checkHealth().then(schedule); }, onQuery: () => { void queryPending(); } });
  const operation = route => /model|core-handoff/.test(route) ? "模型复核" : /paper-trade|execute/.test(route) ? "模拟执行"
    : /revoke/.test(route) ? "撤回确认" : /approve|confirm|reject/.test(route) ? "用户确认" : /audit/.test(route) ? "读取记录"
    : /task\?/.test(route) ? "读取任务" : "风险检查";
  function showFailure(info) {
    lastFailureAt = Date.now();
    feedback.show({ ...info, operation: info.operation || operation(info.route || ""), task_id: info.task_id || pending?.task_id,
      requiresReconciliation: info.requiresReconciliation === true || Boolean(pending), pending: info.pending === true || pending?.state === "IN_FLIGHT" });
  }
  function showHealthIssue(code) {
    if (code === healthIncident) return;
    healthIncident = code;
    const current = feedback.current();
    if (current && (current.operation !== "服务连接检查" || current.method !== "GET")) return;
    if (!code) { if (current && !current.requiresReconciliation) feedback.hide(); return; }
    feedback.show({ code, operation: "服务连接检查", method: "GET", sent: code !== "NETWORK_OFFLINE" });
  }

  function savePending(info) {
    // Keep only correlation identifiers, never balances, notes, cookies, or credentials.
    if (!pending) pending = { route: info.route, task_id: info.task_id || null, idempotency_key: info.idempotency_key || null, at: new Date().toISOString() };
    if (!pending.task_id && info.task_id) pending.task_id = info.task_id;
    if (!pending.idempotency_key && info.idempotency_key) pending.idempotency_key = info.idempotency_key;
    pending.state = "UNKNOWN";
    try { sessionStorage.setItem(pendingKey, JSON.stringify(pending)); } catch { /* The current page still blocks repeat submission. */ }
    render();
    showFailure(info);
  }
  const client = window.RiskNetwork.createClient({
    isOnline: () => !offline,
    onUncertain: savePending,
    onActivity: info => { if (info.phase === "failed" && info.route !== "/api/safety/health" && !info.requiresReconciliation) showFailure(info); }
  });

  function enforceButtons() {
    if (writable()) return;
    for (const id of writeIds) { const button = el(id); if (button) button.disabled = true; }
    for (const button of document.querySelectorAll('#daily-form button[type="submit"]')) button.disabled = true;
  }
  function render() {
    const state = offline ? "offline" : !fresh() ? "checking" : health.services.storage.status !== "UP" ? "error" : health.overall !== "UP" ? "degraded" : "connected";
    panel.dataset.state = state;
    const message = offline ? "网络已断开。请检查网络；已提交的操作不会自动重发。"
      : !fresh() ? "正在核对服务状态，暂不提交新操作。"
      : health.services.storage.status !== "UP" ? "数据服务暂不可用，相关操作已暂停。请稍后重新检查。"
      : health.services.core.status !== "UP" ? "工作台可连接；模型后端暂不可达。可核对本地规则，模型调用暂停。"
      : "工作台与服务健康检查已响应；这不代表任务已经获批或执行。";
    text("connection-summary", message);
    const core = health?.services.core;
    text("connection-services", health ? `工作台：已响应 · 数据存储：${health.services.storage.status === "UP" ? "可用" : "暂不可用"} · Core：${core.status === "UP" ? "已响应" : "暂不可达"} · 模型：${core.model_configured === true ? "已配置，未测试推理" : core.model_configured === false ? "尚未配置" : "状态未核实"}` : "尚未取得本次健康检查结果。");
    text("connection-time", lastCheck ? `最近核对：${new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(lastCheck)}（北京时间）` : "");
    el("connection-check").disabled = Boolean(healthPending) || offline;
    el("connection-pending").hidden = !pending;
    if (pending) text("connection-pending-message", pending.task_id
      ? `有一项已提交操作的结果待核查。原任务：${pending.task_id}。暂不再提交；先查询原任务及回执。`
      : "有一项请求未取得可验证结果，且尚无可核对的任务编号。请由团队核查服务端记录；暂不再次创建请求。");
    el("connection-query").disabled = offline || !pending?.task_id;
    window.dispatchEvent(new CustomEvent("risk:connection"));
    enforceButtons();
  }
  function validHealth(value) {
    return value?.schema_version === "risk-service-health.v1" && ["UP", "DEGRADED"].includes(value.overall) &&
      value.execution_allowed === false && value.business_acceptance === "NOT_VERIFIED" && value.services?.workbench?.status === "UP" &&
      ["UP", "UNAVAILABLE", "NOT_CONFIGURED"].includes(value.services.storage?.status) && ["UP", "UNAVAILABLE"].includes(value.services.core?.status) &&
      [true, false, null].includes(value.services.core.model_configured) && value.services.core.inference_probe === "NOT_RUN";
  }
  async function checkHealth() {
    if (offline || document.hidden) return;
    if (healthPending) return healthPending;
    const epoch = connectionEpoch;
    healthPending = (async () => {
      try {
        const value = await client.requestJson("/api/safety/health", { timeoutMs: 7000 });
        if (!validHealth(value)) throw new Error("健康检查格式无效。");
        if (epoch === connectionEpoch) { health = value; lastCheck = Date.now(); }
      } catch {
        health = null; lastCheck = 0; panel.dataset.state = "error";
      } finally {
        healthPending = null; render();
        if (!health && !offline) { panel.dataset.state = "error"; text("connection-summary", "暂时无法核实服务状态，提交入口已暂停。请检查网络后重新检查连接。"); }
        showHealthIssue(offline ? "NETWORK_OFFLINE" : !health || health.services.storage.status !== "UP" ? "HEALTH_UNAVAILABLE" : health.services.core.status !== "UP" ? "CORE_UNAVAILABLE" : "");
        if (epoch !== connectionEpoch && !offline && !document.hidden) queueMicrotask(() => { void checkHealth(); });
      }
    })();
    el("connection-check").disabled = true;
    return healthPending;
  }
  async function requestBase(route, data, { csrf } = {}) {
    if (data !== undefined && !writable()) {
      const error = new Error(pending ? "上一项操作结果待核查，不能重复提交或创建新操作。" : offline ? "网络已断开，尚未提交本次请求。" : "服务状态尚未核实，请先重新检查连接。");
      error.code = pending ? "PENDING_OPERATION_REQUIRES_RECONCILIATION" : "CONNECTION_NOT_READY";
      error.sent = false;
      throw error;
    }
    if (data !== undefined && /\/(?:model-demo|model-review|core-handoff)$/.test(route) && health.services.core.status !== "UP") {
      const error = new Error("模型后端暂不可达，本次未提交模型请求。请先检查连接。"); error.code = "CORE_UNAVAILABLE"; error.sent = false; throw error;
    }
    if (data === undefined) return client.requestJson(route);
    const original = { route: route.split("?")[0], task_id: data.task_id || data.input?.binding?.task_id || null,
      idempotency_key: data.idempotency_key || null, state: "IN_FLIGHT", at: new Date().toISOString() };
    const marker = JSON.stringify(original);
    try { sessionStorage.setItem(pendingKey, marker); if (sessionStorage.getItem(pendingKey) !== marker) throw new Error("Local state not retained."); }
    catch { const error = new Error("无法保存本次请求的待核查标记，尚未发送。请启用本页会话存储后再检查连接。"); error.code = "LOCAL_STORAGE_UNAVAILABLE"; error.sent = false; throw error; }
    pending = original; render();
    const clearKnown = () => { try { sessionStorage.removeItem(pendingKey); pending = null; } catch { savePending(original); } };
    try {
      const value = await client.requestJson(route, { method: "POST", headers: { "Content-Type": "application/json", "X-Risk-Csrf": csrf || "" }, body: data });
      if (pending?.state === "IN_FLIGHT") clearKnown();
      return value;
    } catch (error) {
      if (error.requiresReconciliation) savePending(original); else clearKnown();
      throw error;
    } finally { render(); }
  }
  async function request(route, data, options) {
    try { return await requestBase(route, data, options); }
    catch (error) {
      showFailure({ route, method: data === undefined ? "GET" : "POST", code: offline && error.sent === false ? "NETWORK_OFFLINE" : error.code,
        sent: error.sent, requiresReconciliation: error.requiresReconciliation, pending: error.pending, httpStatus: error.httpStatus,
        task_id: data?.task_id || data?.input?.binding?.task_id });
      throw error;
    }
  }
  function reportUiError() {
    if (Date.now() - lastFailureAt >= 1500 || !feedback.current()) showFailure({ code: "INPUT_VALIDATION", sent: false, operation: "当前操作" });
    const current = feedback.current();
    return current ? `${current.problem} ${current.state} ${current.recovery}` : "本次操作未完成，请核对资料和确认项。";
  }
  async function queryPending() {
    if (!pending?.task_id || offline) return;
    const original = { ...pending }; el("connection-query").disabled = true;
    try {
      const task = await client.requestJson(`/api/safety/task?task_id=${encodeURIComponent(original.task_id)}`);
      const id = task.input?.binding?.task_id || task.task_id;
      if (id !== original.task_id) throw new Error("读取结果与原任务不一致，不能解除暂停。");
      const execution = task.execution || {};
      el("connection-query-result").hidden = false;
      text("connection-query-result", JSON.stringify({ task_id: id, approval: task.input?.approval?.status ?? null,
        execution_status: execution.status || "NOT_VERIFIED", receipt: execution.receipt || execution.result || null }, null, 2));
      // Only a terminal receipt tied to the original execution key can clear this guard.
      // Other mutations need owner-side reconciliation; reading an old task is not proof.
      const receiptKey = execution.idempotency_key || execution.receipt?.idempotency_key;
      if (original.route === "/api/paper-trade/execute" && original.idempotency_key && receiptKey === original.idempotency_key &&
          ["SUCCEEDED", "FAILED", "ABORTED"].includes(execution.status)) {
        pending = null; try { sessionStorage.removeItem(pendingKey); } catch { /* No financial state is stored here. */ }
        window.dispatchEvent(new CustomEvent("risk:reconciled", { detail: task }));
        if (feedback.current()?.requiresReconciliation) feedback.hide();
      } else text("connection-pending-message", "已读取原任务，但还不足以确认本次请求的最终回执。继续暂停提交，请核查关联审计；不会重发操作。");
    } catch (error) { text("connection-pending-message", `原任务查询未完成：${error.message} 暂停状态保持。`); }
    finally { el("connection-query").disabled = offline || !pending?.task_id; if (!pending) render(); }
  }
  function schedule() { clearTimeout(timer); if (!document.hidden && !offline) timer = setTimeout(async () => { await checkHealth(); schedule(); }, 30000); }
  window.addEventListener("offline", () => { connectionEpoch++; offline = true; health = null; lastCheck = 0; clearTimeout(timer); render(); if (pending) showFailure({ code: "NETWORK_OFFLINE", sent: true, requiresReconciliation: true }); else showHealthIssue("NETWORK_OFFLINE"); });
  window.addEventListener("online", () => { connectionEpoch++; offline = false; health = null; lastCheck = 0; render(); void checkHealth().then(schedule); });
  document.addEventListener("visibilitychange", () => { clearTimeout(timer); if (!document.hidden) { if (!fresh()) { health = null; render(); } void checkHealth().then(schedule); } });
  window.addEventListener("pagehide", () => clearTimeout(timer));
  window.addEventListener("pageshow", () => { if (!document.hidden) void checkHealth().then(schedule); });
  el("connection-check").addEventListener("click", () => { health = null; lastCheck = 0; render(); void checkHealth().then(schedule); });
  el("connection-query").addEventListener("click", queryPending);
  window.RiskConnection = { request, enforceButtons, checkHealth, reportUiError };
  if (pending) showFailure({ code: "SERVER_RESULT_UNKNOWN", requiresReconciliation: true, sent: true });
  render(); void checkHealth().then(schedule);
})();
