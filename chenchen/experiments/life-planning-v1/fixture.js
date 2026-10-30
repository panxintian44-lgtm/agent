"use strict";

const { IntakeSessions } = require("./intake");
const { planPurchases } = require("./planning");
const { buildReport } = require("./report");
const { ReviewWorkflowStore } = require("../../integrations/review-workflow");
const { runReview } = require("../../integrations/model-review");
const { buildRiskHandoffPackage } = require("../../integrations/risk-handoff");

const AS_OF = "2026-10-17T12:00:00+08:00";
const clock = { now: () => new Date(AS_OF) };
function example() {
  const quote = { comparison_key: "fixture-phone-256GB-new-standard-warranty", quantity: 1, match_confirmed: true,
    currency: "CNY", quoted_at: "2026-10-17T10:00:00+08:00", valid_until: "2026-10-18T10:00:00+08:00",
    shipping_minor: 0, fees_minor: 0, coupons: [] };
  return { data_mode: "FIXTURE", as_of: AS_OF,
    comparison: { comparison_key: quote.comparison_key, quantity: 1, quotes: [
      { ...quote, quote_id: "shop-a", platform: "虚构平台A", source_ref: "fixture://quote-a", unit_price_minor: 300000,
        coupons: [{ coupon_id: "coupon-a", discount_minor: 20000, threshold_minor: 250000, eligible: true,
          starts_at: "2026-10-17T00:00:00+08:00", ends_at: "2026-10-18T00:00:00+08:00" }] },
      { ...quote, quote_id: "shop-b", platform: "虚构平台B", source_ref: "fixture://quote-b", unit_price_minor: 275000, shipping_minor: 1000 }
    ] },
    subscriptions: { through: "2026-11-17T12:00:00+08:00", bills: [
      { bill_id: "video-next", service: "虚构视频会员", currency: "CNY", amount_minor: 2500,
        due_at: "2026-10-20T09:00:00+08:00", status: "CANCELLATION_REQUESTED", source_ref: "fixture://bill-video" },
      { bill_id: "storage-next", service: "虚构云盘", currency: "CNY", amount_minor: 1000,
        due_at: "2026-11-01T09:00:00+08:00", status: "SCHEDULED", source_ref: "fixture://bill-storage" }
    ] }
  };
}
function binding(draft) {
  return { draft_id: draft.draft_id, revision: draft.revision, interpretation_sha256: draft.interpretation_sha256 };
}
function confirmedExample() {
  const sessions = new IntakeSessions(clock);
  const initial = sessions.create({ text: "我想投入8,000元买基金，但下个月要交房租4500元；学费6000元已经交了。双十一买手机3000元，视频会员每月25元。如果工资到账，再考虑投资。",
    data_mode: "FIXTURE", channel: "speech_transcript", is_final: true });
  const draft = sessions.attachPlan({ ...binding(initial), plan_input: example() });
  const confirmed = sessions.confirm({ ...binding(draft), confirmed: true, reviewed_candidate_ids: draft.candidates.map(c => c.candidate_id),
    reviewed_plan_sha256: draft.attached_plan.plan_sha256 });
  return { draft: confirmed, review: sessions.reviewRequest(binding(confirmed)) };
}

async function runFixture({ riskDecision = "APPROVE", failModel = false } = {}) {
  if (!["APPROVE", "REJECT", "REQUEST_MORE_INFO"].includes(riskDecision)) throw new TypeError("Invalid fixture Risk decision");
  const { draft, review } = confirmedExample();
  const transportLog = [];
  const store = new ReviewWorkflowStore({ modelRunner: input => runReview(input, {
    MODEL_PROVIDER: "deepseek", MODEL_API_URL: "https://synthetic-provider.invalid/v1/chat/completions",
    MODEL_API_KEY: "synthetic-test-only", MODEL_NAME: "synthetic-model", MODEL_MAX_ATTEMPTS: "1", MODEL_DISABLE_RULE_FALLBACK: "true"
  }, { fetchImpl: async (_url, options) => {
    transportLog.push({ source: "SYNTHETIC_TRANSPORT", network_called: false, request: JSON.parse(options.body) });
    if (failModel) return new Response('{"error":{"code":"synthetic_unavailable"}}', { status: 503 });
    return new Response(JSON.stringify({ id: "synthetic-model-response", model: "synthetic-model",
      choices: [{ message: { content: JSON.stringify({ summary: "请先核实生活用途与待扣账单。", risk_level: "unknown",
        proposed_action: "HOLD_FOR_REVIEW", action_reason: "未核实的金额不能授权付款。",
        missing_information: ["可信账户与已确认用途"], evidence: ["虚构输入中的房租及投资计划"] }) } }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } }), { status: 200 });
  } }) });
  let workflow;
  let handoff = null;
  const checkpoints = [];
  try { workflow = await store.start({ ...review.request, capability: "SIMULATION_ONLY" }); }
  catch (error) {
    if (!failModel || !error.workflowRecord) throw error;
    workflow = error.workflowRecord;
  }
  checkpoints.push(workflow.status);
  if (!failModel) {
    handoff = buildRiskHandoffPackage(workflow);
    const base = { task_id: workflow.task_id, proposal_sha256: workflow.proposed_action.proposal_sha256 };
    try { await store.simulate(base); throw new Error("Expected execution to be blocked"); }
    catch (error) { if (error.code !== "EXECUTION_BLOCKED") throw error; checkpoints.push("BLOCKED_BEFORE_RISK"); }
    const callback = { callback_version: "risk-callback.v1", task_id: workflow.task_id, request_id: workflow.request_id,
      run_id: workflow.run_id, audit_id: workflow.audit.audit_id, handoff_id: workflow.risk_handoff.handoff_id,
      proposal_sha256: base.proposal_sha256, decision: riskDecision, reviewer: "synthetic-risk-owner", reason: "Fixture callback; not a real Risk verdict" };
    workflow = (await store.receiveRiskCallback(callback)).workflow;
    checkpoints.push(workflow.status);
    if (riskDecision === "APPROVE") {
      try { await store.simulate(base); throw new Error("Expected human approval to be required"); }
      catch (error) { if (error.code !== "EXECUTION_BLOCKED") throw error; checkpoints.push("BLOCKED_BEFORE_APPROVAL"); }
      workflow = await store.decideApproval({ ...base, decision: "APPROVE", approver: "synthetic-user", reason: "Synthetic approval for PAPER only" });
      checkpoints.push(workflow.status);
      workflow = await store.simulate(base);
      checkpoints.push(workflow.status);
    }
  }
  const plan = planPurchases(example());
  return { evidence_mode: "SYNTHETIC_LOCAL_TEST", network_calls: 0, paid_model_calls: 0,
    live_model_verified: false, risk_owner_verified: false, joint_acceptance: false,
    checkpoints, draft, review, transport_log: transportLog, handoff, workflow, plan,
    report: buildReport(plan, { run_id: workflow.run_id, audit_id: workflow.audit.audit_id }) };
}
if (require.main === module) {
  runFixture().then(result => process.stdout.write(JSON.stringify(result, null, 2) + "\n"))
    .catch(error => { console.error(error.code || "FIXTURE_FAILED", error.message); process.exitCode = 1; });
}
module.exports = { AS_OF, clock, example, binding, confirmedExample, runFixture };
