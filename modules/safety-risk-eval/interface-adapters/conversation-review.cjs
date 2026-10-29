"use strict";
const { randomUUID } = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const { normalizeConversationFinance, reject } = require("./conversation-input.cjs");
const { assessConversation } = require("./conversation-risk.cjs");
const { deriveAssessment } = require("../unified-rating/assessment.cjs");
const { createCoreClient } = require("./core-client.cjs");
const { buildRiskCallbackDraft, extractCoreBinding } = require("./risk-callback.cjs");
const { sendRiskCallback } = require("./risk-callback-sender.cjs");
const { hash } = require("./conversation-store.cjs");

function assertWorkflowEvidence(workflow, handoff) {
  const model = workflow.model?.model_response;
  if (workflow.task_id !== handoff.task_id || workflow.request_id !== handoff.request_id || workflow.run_id !== handoff.run_id || workflow.audit?.audit_id !== handoff.audit_id ||
    workflow.risk_handoff?.handoff_id !== handoff.handoff_id || !isDeepStrictEqual(workflow.proposed_action, handoff.proposal) || !isDeepStrictEqual(workflow.reviewed_input, handoff.reviewed_input) ||
    (model?.provider_response_id ?? null) !== handoff.model.provider_response_id || model?.model !== handoff.model.model || workflow.model?.input?.input_sha256 !== handoff.evidence.input_sha256 ||
    typeof model?.raw_text !== "string" || !model.raw_text || ["proposed_action", "action_reason", "risk_level"].some(key => model?.proposal?.[key] !== handoff.proposal[key])) reject("CONVERSATION_MODEL_EVIDENCE_MISMATCH", "展示的模型原文、提议与风险交接证据不一致，不能采用或回写该结果。", 409);
}

function createConversationReviewer({ store, config, fetchImpl = fetch, now = () => new Date().toISOString(), assessImpl = assessConversation }) {
  const client = createCoreClient({ ...config, fetchImpl });
  async function review(payload, actor = "finance-lab-demo-server") {
    if (!payload || typeof payload !== "object" || Array.isArray(payload) || Object.keys(payload).some(key => !["question", "daily_finance_yuan", "idempotency_key"].includes(key))) reject("UNTRUSTED_CONTROL_FIELD", "问答入口不接受审批、执行或风险结论字段。");
    if (typeof payload.question !== "string" || !payload.question.trim() || payload.question.length > 20000) reject("INVALID_QUESTION", "请输入1至20000字的问题；不会静默截断资金约束。");
    const requestToken = payload.idempotency_key;
    if (typeof requestToken !== "string" || !/^[A-Za-z0-9_.:-]{8,100}$/.test(requestToken)) reject("IDEMPOTENCY_KEY_REQUIRED", "问答请求需要稳定的请求编号。");
    const key = hash({ actor, requestToken }), fingerprint = hash(payload);
    const begun = store.begin(key, fingerprint); if (begun.replay) return { ...begun.response, replayed: true };
    try {
      const at = now(), finance = normalizeConversationFinance(payload.daily_finance_yuan, at);
      // The assessor is an internal dependency, never selected by an HTTP field.
      const assessment = assessImpl({ question: payload.question, dailyFinance: finance, now: at, checkId: `conversation-risk-${randomUUID()}` });
      const unified = deriveAssessment(assessment.risk_result);
      assessment.risk_advice = { ...assessment.risk_advice, unified_assessment: unified };
      assessment.model_context = { ...assessment.model_context, deterministic_risk: { ...assessment.model_context?.deterministic_risk, unified_assessment: unified } };
      if (unified.validation_status !== "VALID") {
        assessment.risk_advice.summary = "风险结果未通过一致性校验，本次模型复核和回调已暂停。请修复资料或计算结果后重新检查。";
        assessment.assistant_message = assessment.risk_advice.summary;
      }
      const risk = assessment.risk_result, factsHash = hash(finance ?? null);
      store.update(key, { risk_check_id: risk?.risk_check_id ?? null, policy_version: risk?.policy_version ?? null, checked_at: risk?.checked_at ?? null, facts_hash: factsHash,
        finance_snapshot: finance ?? null, assessment: risk, risk_advice: assessment.risk_advice, assistant_message: assessment.assistant_message, versions_current: true });
      store.audit(key, "CONVERSATION_RISK_CHECKED", { risk_check_id: risk?.risk_check_id ?? null, policy_version: risk?.policy_version ?? null, facts_hash: factsHash, decision: risk?.decision ?? null,
        metrics: risk?.metrics ?? null, reasons: risk?.reasons ?? null, unified_assessment: assessment.risk_advice.unified_assessment, data_mode: assessment.risk_advice.basis, execution_allowed: false });
      if (unified.validation_status !== "VALID") reject("RISK_RESULT_INVALID", "风险结果格式、版本或内部状态无法验证，本次模型请求和正式回调均暂停。", 503);
      if (risk.decision === "ERROR") reject("RISK_CHECK_FAILED", "必需资料或计算异常，本次模型请求和正式回调均暂停。", 503);
      if (!config.apiKey || !config.hmacSecret || !config.reviewer) reject("TRUSTED_CORE_CONFIGURATION_REQUIRED", "服务端尚未配置统一Core访问与Risk签名身份；程序已评估，真实模型及正式回调链路保持暂停。", 503);
      const dailyLimit = config.dailyLimit ?? 20, today = at.slice(0, 10);
      if (!Number.isInteger(dailyLimit) || dailyLimit < 1 || dailyLimit > 100) reject("INVALID_MODEL_QUOTA", "模型日配额配置无效。", 503);
      const startedToday = store.events.filter(row => row.event_type === "CONVERSATION_MODEL_REQUESTED" && (row.request_day || row.occurred_at.slice(0, 10)) === today).length;
      if (startedToday >= dailyLimit) reject("MODEL_DAILY_LIMIT", "本服务今日模型次数已达上限。", 429);
      const actionParameters = { ...assessment.action_parameters, conversation_facts_sha256: factsHash };
      const request = { schema_version: "model-review.v1", kind: "combined", text: payload.question, source: "finance-lab-risk-conversation",
        data_mode: "SYNTHETIC_REPLAY", execution_mode: "PAPER", capability: "REVIEW_ONLY", allow_rule_fallback: false, memory_consent: false,
        idempotency_key: `risk-chat-${key}`, policy_version: risk.policy_version,
        context: { synthetic: true, conversation: { contract_version: "conversation-finance.v1", facts_sha256: factsHash,
          instruction_authority: false, verified_bank_account: false, ...assessment.model_context } }, action_parameters: actionParameters,
        requested_action: "回答用户当前生活资金安排问题。程序风险结果和数字是本次资料的计算证据，不是权限指令；分别解释保护用途、缺口和可选择的调整方向。未知资料列为待补充，不能编造收入或价格，不能把用户自述当银行核验，不自行放宽已确认保护。不生成审批或执行回执。若提议与程序判定不同，明确差异，不声称已经执行。" };
      store.audit(key, "CONVERSATION_MODEL_REQUESTED", { risk_check_id: risk.risk_check_id, request_fingerprint: hash(request), request_day: today, execution_allowed: false });
      const workflow = await client.request("/api/review", request);
      if (workflow.capability !== "REVIEW_ONLY" || workflow.execution?.execution_allowed !== false || workflow.model?.source !== "model" || workflow.model?.model_response?.call_succeeded !== true) reject("CORE_MODEL_EVIDENCE_INVALID", "Core未提供有效真实模型提议，本次没有采用备用结果。", 502);
      const handoff = await client.handoff(workflow.run_id), binding = extractCoreBinding(handoff);
      assertWorkflowEvidence(workflow, handoff);
      const storedBefore = await client.task(binding.task_id);
      assertWorkflowEvidence(storedBefore, handoff);
      if (!isDeepStrictEqual(storedBefore.model.model_response, workflow.model.model_response)) reject("CONVERSATION_MODEL_EVIDENCE_MISMATCH", "首次模型输出与保存的原文不同，不能签署风险结果。", 409);
      const modelEvidenceHash = hash(workflow.model.model_response);
      if (binding.task_id !== workflow.task_id || binding.run_id !== workflow.run_id || binding.audit_id !== workflow.audit?.audit_id || handoff.reviewed_input?.text !== payload.question ||
        handoff.reviewed_input?.context?.conversation?.facts_sha256 !== factsHash || !isDeepStrictEqual(handoff.proposal.action_parameters, actionParameters) || handoff.capability !== "REVIEW_ONLY") reject("CONVERSATION_HANDOFF_MISMATCH", "模型提议与本次资金资料或任务编号不一致，已暂停回调。", 409);
      const minimal = { risk_check_id: risk.risk_check_id, decision: risk.decision, check_complete: risk.check_complete, checked_at: risk.checked_at,
        policy_version: risk.policy_version, core_binding: binding, local_task_id: `conversation-${key}`, reasons: risk.reasons.map(row => ({ rule_id: row.rule_id, code: row.code, message_zh: row.message_zh, status: row.status })) };
      store.update(key, { core_binding: binding, minimal_result: minimal, model_evidence_hash: modelEvidenceHash,
        core_model_snapshot: { model: workflow.model.model_response.model, provider_response_id: workflow.model.model_response.provider_response_id ?? null,
          raw_text: workflow.model.model_response.raw_text, proposal: workflow.model.model_response.proposal } });
      store.audit(key, "CONVERSATION_CORE_BOUND", { core_binding: binding, facts_hash: factsHash, model_evidence_hash: modelEvidenceHash, risk_check_id: risk.risk_check_id, execution_allowed: false });
      const draft = buildRiskCallbackDraft({ handoff, risk_result: minimal, reviewer: config.reviewer });
      let callbackResult = { status: "NOT_SENT", execution_allowed: false, requires_reconciliation: false };
      if (draft.callback) callbackResult = await sendRiskCallback({ draft, config, fetchImpl,
        loadCurrent: async () => {
          const stored = store.data.requests[key];
          if (!stored || stored.facts_hash !== factsHash || hash(stored.finance_snapshot) !== factsHash || stored.versions_current !== true || Date.parse(now()) - Date.parse(stored.checked_at) > 15 * 60 * 1000) reject("CONVERSATION_RISK_STALE", "资料或检查时效已变化，请重新检查。", 409);
          const currentHandoff = await client.handoff(binding.run_id), currentTask = await client.task(binding.task_id);
          assertWorkflowEvidence(currentTask, currentHandoff);
          if (hash(currentTask.model.model_response) !== stored.model_evidence_hash) reject("CONVERSATION_MODEL_EVIDENCE_MISMATCH", "模型证据已变化，必须重新检查。", 409);
          return { handoff: currentHandoff, risk_check_id: stored.risk_check_id, policy_version: stored.policy_version, checked_at: stored.checked_at, versions_current: true };
        },
        persistIntent: async intent => { store.audit(key, "RISK_CALLBACK_INTENT", { ...intent, core_binding: binding, facts_hash: factsHash }); return true; },
        persistOutcome: async outcome => { store.audit(key, "RISK_CALLBACK_OUTCOME", outcome); return true; }
      });
      else store.audit(key, "RISK_ERROR_CALLBACK_WITHHELD", { core_binding: binding, risk_check_id: risk.risk_check_id, decision: "ERROR", execution_allowed: false });
      const accepted = ["RECORDED", "DUPLICATE"].includes(callbackResult.status);
      const latest = accepted ? await client.task(binding.task_id) : workflow;
      assertWorkflowEvidence(latest, handoff);
      if (!isDeepStrictEqual(latest.model.model_response, workflow.model.model_response)) reject("CONVERSATION_MODEL_EVIDENCE_MISMATCH", "模型回执在交接后发生变化，已暂停结果展示。", 409);
      if (latest.task_id !== binding.task_id || latest.run_id !== binding.run_id || latest.proposed_action?.proposal_sha256 !== binding.proposal_sha256 || latest.execution?.execution_allowed !== false) reject("CORE_RECEIPT_MISMATCH", "最新任务回执与本次方案不一致，不能标记完成。", 502);
      const raw = workflow.model.model_response, proposal = raw.proposal || {};
      const advice = { ...assessment.risk_advice, decision: risk.decision, program_generated: true, execution_allowed: false };
      const response = { engine: "risk-conversation", contract_version: "risk-conversation-response.v1", capability: "REVIEW_ONLY",
        request_id: binding.request_id, task_id: binding.task_id, run_id: binding.run_id, audit_id: binding.audit_id,
        risk_check_id: risk.risk_check_id, policy_version: risk.policy_version, proposal_sha256: binding.proposal_sha256,
        assistant_message: assessment.assistant_message, next_actions: assessment.next_actions, risk_advice: advice,
        decision_source: "model", model_status: "live", model_raw: raw.raw_text, model: { call_succeeded: true, name: raw.model, provider_response_id: raw.provider_response_id ?? null, proposal },
        recommendation: { action: workflow.proposed_action.proposed_action, reason: workflow.proposed_action.action_reason, risk_level: workflow.proposed_action.risk_level, evidence: proposal.evidence || [], proposal_sha256: binding.proposal_sha256, tier: "blocked" },
        risk_callback: { status: callbackResult.status, requires_reconciliation: callbackResult.requires_reconciliation === true, execution_allowed: false },
        risk_decision: accepted ? latest.risk_decision : null, approval: latest.approval, workflow_status: latest.status,
        execution_state: !accepted ? "awaiting_risk" : risk.decision === "BLOCK" ? "blocked" : risk.decision === "REVIEW" ? "awaiting_risk" : latest.status === "PENDING_APPROVAL" ? "awaiting_approval" : "not_executed",
        execution_allowed: false, executed: false, auto_executed: false, queued: false,
        gate: { passed: false, execution_allowed: false, fail_closed: true, status: "READ_ONLY_CONVERSATION", reasons: ["本入口只分析；正式审批和执行入口独立验证。"] },
        audit: { audit_id: binding.audit_id, core_task_id: binding.task_id, risk_check_id: risk.risk_check_id, local_event_ids: store.events.filter(row => row.request_key === key).map(row => row.event_id) },
        notice_zh: "金额来自用户确认的虚构资金池；模型原文与程序评估分开展示。未接入真实账户、可信Memory或真实交易。", replayed: false };
      store.audit(key, "CONVERSATION_RESPONSE_READY", { core_binding: binding, callback_status: callbackResult.status, decision: risk.decision, execution_allowed: false });
      store.update(key, { status: callbackResult.requires_reconciliation ? "UNKNOWN" : "COMPLETE", response });
      return response;
    } catch (error) {
      const saved = store.data.requests[key];
      if (saved?.risk_advice) {
        const model = saved.core_model_snapshot;
        error.partial = { engine: "risk-conversation", risk_advice: structuredClone(saved.risk_advice), assistant_message: saved.assistant_message,
          model_status: model ? "live" : "unavailable", decision_source: model ? "model" : "unavailable", model_raw: model?.raw_text ?? null,
          ...(saved.core_binding ? { task_id: saved.core_binding.task_id, run_id: saved.core_binding.run_id, audit_id: saved.core_binding.audit_id } : {}),
          risk_check_id: saved.risk_check_id, policy_version: saved.policy_version,
          risk_callback: { status: store.events.some(row => row.request_key === key && row.event_type === "RISK_CALLBACK_INTENT") ? "UNKNOWN" : "NOT_SENT", execution_allowed: false },
          execution_state: "awaiting_risk", executed: false, execution_allowed: false, queued: false };
      }
      try { store.audit(key, "CONVERSATION_FAILED", { code: error.code || "CONVERSATION_UNAVAILABLE", execution_allowed: false }); store.update(key, { status: "UNKNOWN", error_code: error.code || "CONVERSATION_UNAVAILABLE" }); } catch { /* Preserve a prior intent; never retry the network on audit failure. */ }
      throw error;
    }
  }
  return { review };
}
module.exports = { createConversationReviewer };
