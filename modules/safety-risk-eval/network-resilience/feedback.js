(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.RiskFeedback = factory();
}(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const OPERATIONS = new Set(["风险检查", "模型复核", "用户确认", "撤回确认", "模拟执行", "读取任务", "读取记录", "服务连接检查", "当前操作"]);
  const PROBLEMS = Object.freeze({
    NETWORK_TIMEOUT: "等待服务响应超时。",
    NETWORK_OFFLINE: "当前网络已断开。",
    NETWORK_ERROR: "无法取得服务响应，可能存在网络或服务连接问题。",
    NETWORK_STATE_UNAVAILABLE: "暂时无法确认当前网络状态。",
    INVALID_RESPONSE: "服务响应格式无法验证，本次不能采用该响应。",
    RESPONSE_TOO_LARGE: "服务响应超过大小限制，本次不能采用该响应。",
    REDIRECT_REJECTED: "服务返回了未允许的跳转，已停止继续访问。",
    HTTP_UNAUTHORIZED: "登录或访问身份已失效。",
    HTTP_FORBIDDEN: "当前访问权限不足，服务拒绝了本次请求。",
    HTTP_RATE_LIMITED: "请求过于频繁，或服务额度已达到上限。",
    HTTP_CLIENT_ERROR: "服务拒绝了本次请求，请核对当前操作条件。",
    HTTP_SERVER_ERROR: "服务端暂时不可用。",
    HTTP_ERROR: "服务没有返回预期的成功响应。",
    SERVER_REPORTED_ERROR: "服务返回了业务错误，需要核查本次请求。",
    SERVER_RESULT_UNKNOWN: "服务未确认原请求的最终结果。",
    SERVER_RESULT_PENDING: "服务报告原请求仍在处理中。",
    INVALID_ROUTE: "当前接口地址不符合本站访问要求。",
    INVALID_REQUEST: "当前请求参数格式不正确。",
    INPUT_VALIDATION: "资料或确认项不完整，请检查当前操作旁的提示并修改。",
    LOCAL_STORAGE_UNAVAILABLE: "待核查标记无法可靠保存，不能安全发起新的操作。",
    CORE_UNAVAILABLE: "模型后端当前不可用。",
    HEALTH_UNAVAILABLE: "服务或存储健康状态无法核实，当前提交保持暂停。",
    PENDING_OPERATION_REQUIRES_RECONCILIATION: "存在尚未核清的原请求，不能重复提交。",
    CONNECTION_NOT_READY: "服务连接尚未就绪。",
    REQUEST_FAILED: "当前操作没有取得可确认的结果。"
  });
  const REJECTIONS = new Set(["HTTP_UNAUTHORIZED", "HTTP_FORBIDDEN", "HTTP_RATE_LIMITED", "HTTP_CLIENT_ERROR", "INPUT_VALIDATION", "INVALID_REQUEST", "INVALID_ROUTE"]);
  const presenters = new WeakMap();

  function describe(info) {
    const source = info && typeof info === "object" && !Array.isArray(info) ? info : {};
    const code = typeof source.code === "string" && Object.hasOwn(PROBLEMS, source.code) ? source.code : "REQUEST_FAILED";
    const operation = OPERATIONS.has(source.operation) ? source.operation : "当前操作";
    const method = ["GET", "POST", "PUT", "PATCH", "DELETE"].includes(source.method) ? source.method : null;
    const taskId = typeof source.task_id === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/.test(source.task_id) ? source.task_id : null;
    const pending = source.pending === true || code === "SERVER_RESULT_PENDING";
    const reconcile = source.requiresReconciliation === true || pending || ["SERVER_RESULT_UNKNOWN", "PENDING_OPERATION_REQUIRES_RECONCILIATION"].includes(code);
    const sent = source.sent === true ? true : source.sent === false ? false : null;
    let title = operation + "未完成", state, recovery;
    if (reconcile) {
      title = operation + (pending ? "仍在处理中" : "结果待核查");
      state = pending ? "原请求仍在处理中，最终结果尚未确认。" : "原请求的处理结果待核查，不能按成功或失败继续。";
      recovery = taskId ? "请核查原任务，确认状态后再决定下一步；不要重复提交、确认或执行。" : "请先检查连接，并由团队凭原请求记录核查结果；不要重复提交、确认或执行。";
    } else if (sent === false) {
      state = "本次请求尚未发送。";
      recovery = code === "INPUT_VALIDATION" || code === "INVALID_REQUEST"
        ? "请查看当前操作旁的字段提示，补齐资料或确认项后再操作。"
        : code === "LOCAL_STORAGE_UNAVAILABLE"
          ? "请先恢复本地标记存储并核查已有待处理记录；不要绕过保存要求。"
          : "请检查网络与服务连接，恢复后由你主动决定是否重新发起。";
    } else if (method === "GET") {
      state = "本次读取未完成；不能据此判断原业务是否已执行。";
      recovery = "请检查网络与服务连接，再以原任务编号读取状态；不要因此重复提交业务操作。";
    } else if (method && method !== "GET" && REJECTIONS.has(code)) {
      state = "服务已拒绝本次请求，当前操作不能继续执行。";
      recovery = code === "INPUT_VALIDATION" || code === "INVALID_REQUEST"
        ? "请查看当前操作旁的字段提示，修正资料与确认项。"
        : "请核对访问权限、输入资料或服务额度；不要绕过当前限制。";
    } else {
      state = "当前操作保持暂停；不能据此判断原业务是否已执行。";
      recovery = "请先检查连接并核查原任务记录，确认处理状态后再决定下一步。";
    }
    return {
      code: code, operation: operation, method: method, task_id: taskId, sent: sent,
      requiresReconciliation: reconcile, pending: pending,
      title: title, problem: PROBLEMS[code], state: state, recovery: recovery,
      reference: "原因代码：" + code + (taskId ? "\n任务编号：" + taskId : ""),
      showQuery: Boolean(taskId && reconcile)
    };
  }

  function callback(hook, value) {
    if (typeof hook !== "function") return;
    try {
      const result = hook(Object.assign({}, value));
      if (result && typeof result.then === "function") Promise.resolve(result).catch(function () {});
    } catch (_) { /* A reporting callback must not dismiss or unlock an operation. */ }
  }

  function createPresenter(options) {
    const config = options || {};
    const doc = config.document || (typeof document !== "undefined" ? document : null);
    if (!doc || typeof doc.createElement !== "function" || !doc.body || typeof doc.body.appendChild !== "function" ||
        [config.onCheck, config.onQuery].some(function (value) { return value !== undefined && typeof value !== "function"; })) throw new TypeError("A document body and optional callback functions are required.");
    if (presenters.has(doc)) {
      const existing = presenters.get(doc);
      existing.hooks.onCheck = config.onCheck; existing.hooks.onQuery = config.onQuery;
      existing.syncButtons(); return existing.api;
    }
    const hooks = { onCheck: config.onCheck, onQuery: config.onQuery };
    const panel = doc.createElement("section");
    panel.id = "risk-operation-alert";
    panel.className = "risk-operation-alert";
    panel.hidden = true;
    panel.setAttribute("role", "alert");
    panel.setAttribute("aria-live", "assertive");
    const fields = {};
    for (const row of [["title", "h3"], ["problem", "p"], ["state", "p"], ["recovery", "p"], ["reference", "pre"]]) {
      const element = doc.createElement(row[1]); element.id = "operation-error-" + row[0]; panel.appendChild(element); fields[row[0]] = element;
    }
    const actions = doc.createElement("div"); actions.className = "operation-error-actions";
    function button(id, label) {
      const element = doc.createElement("button"); element.type = "button"; element.id = id; element.textContent = label; actions.appendChild(element); return element;
    }
    const close = button("operation-error-close", "关闭提示");
    close.setAttribute("aria-label", "关闭提示，不取消或重发操作");
    const check = button("operation-error-check", "检查连接");
    const query = button("operation-error-query", "核查原任务");
    panel.appendChild(actions); doc.body.appendChild(panel);
    let current = null;
    function syncButtons() {
      check.disabled = typeof hooks.onCheck !== "function";
      query.hidden = !current || !current.showQuery;
      query.disabled = typeof hooks.onQuery !== "function";
    }
    const api = {
      show: function (info) {
        current = describe(info);
        for (const key of ["title", "problem", "state", "recovery", "reference"]) fields[key].textContent = current[key];
        syncButtons(); panel.hidden = false;
        return Object.assign({}, current);
      },
      hide: function () { panel.hidden = true; },
      current: function () { return current ? Object.assign({}, current) : null; }
    };
    close.addEventListener("click", function () { api.hide(); });
    check.addEventListener("click", function () { if (!panel.hidden && current) callback(hooks.onCheck, current); });
    query.addEventListener("click", function () { if (!panel.hidden && current && current.showQuery) callback(hooks.onQuery, current); });
    syncButtons();
    presenters.set(doc, { hooks: hooks, syncButtons: syncButtons, api: api });
    return api;
  }

  return { createPresenter: createPresenter, describe: describe };
}));
