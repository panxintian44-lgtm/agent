"use strict";

const crypto = require("node:crypto");
const modelReview = require("./model-review");
const riskHandoff = require("./risk-handoff");
const { FundingPlanStore } = require("./funding-plan");

const WORKFLOW_VERSION = "review-workflow.v1";
const RISK_DECISIONS = ["APPROVE", "REJECT", "REQUEST_MORE_INFO"];
const APPROVAL_DECISIONS = ["APPROVE", "REJECT"];
const APPROVAL_TTL_MS = 15 * 60 * 1000;

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function id(prefix) {
  return prefix + (globalThis.crypto?.randomUUID?.() || crypto.randomUUID());
}

function now() {
  return new Date().toISOString();
}

class WorkflowError extends Error {
  constructor(code, message, { statusCode = 409, retryable = false, stage = "WORKFLOW", recovery = "Review the task state and retry the allowed next step.", details = null, record = null } = {}) {
    super(message);
    this.name = "WorkflowError";
    this.code = code;
    this.statusCode = statusCode;
    this.retryable = retryable;
    this.stage = stage;
    this.recovery = recovery;
    this.details = details;
    this.record = record;
    this.taskId = record?.task_id || null;
    this.runId = record?.run_id || null;
    this.auditId = record?.audit?.audit_id || null;
  }
}

function decisionValue(value, allowed, field) {
  const result = String(value || "").trim().toUpperCase();
  if (!allowed.includes(result)) {
    throw new WorkflowError("INVALID_WORKFLOW_INPUT", `${field} must be ${allowed.join(", ")}`, {
      statusCode: 422,
      stage: "VALIDATION",
      recovery: `Use one of: ${allowed.join(", ")}.`
    });
  }
  return result;
}

function requiredString(value, field) {
  if (typeof value !== "string" || !value.trim() || value.length > 500) {
    throw new WorkflowError("INVALID_WORKFLOW_INPUT", `${field} must be a non-empty string of at most 500 characters`, {
      statusCode: 422,
      stage: "VALIDATION",
      recovery: `Provide ${field} and retry.`
    });
  }
  return value.trim();
}

async function hash(value) {
  const data = new TextEncoder().encode(JSON.stringify(value));
  const digest = await (globalThis.crypto?.subtle || crypto.webcrypto.subtle).digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

function requestIdentity(input) {
  const canonical = clone(input);
  delete canonical.request_id;
  delete canonical.task_id;
  delete canonical.idempotency_key;
  delete canonical.session_id;
  return canonical;
}

function orderedKeys(value) {
  if (Array.isArray(value)) return value.map(orderedKeys);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, orderedKeys(value[key])]));
  return value;
}

async function fingerprint(input) {
  return hash(orderedKeys(requestIdentity(input)));
}

async function matchesFingerprint(expected, input) {
  if (typeof expected !== "string") return false;
  const identity = requestIdentity(input);
  if (expected === await hash(orderedKeys(identity))) return true;
  // Existing durable records used insertion-order JSON. Accept only the exact
  // legacy digest, without dropping context, changing values or sorting arrays.
  return expected === await hash(identity);
}

async function matchesRequestFingerprint(record, input) {
  // Keep legacy content digests intact, but never reuse them across declared contexts.
  // Do not attach the existing record to a foreign-context error response.
  if (record && ((input.session_id && input.session_id !== record.session_id) ||
      (input.task_id && input.task_id !== record.task_id))) {
    throw new WorkflowError("IDEMPOTENCY_CONTEXT_MISMATCH", "idempotency key is bound to another session or task", {
      statusCode: 409, stage: "VALIDATION",
      recovery: "Use a new idempotency key for a different session or task."
    });
  }
  if (await matchesFingerprint(record?.request_fingerprint, input)) return true;
  // Only the two newly defaulted fields may be absent from a legacy request.
  // The original stored digest still has to match all remaining input fields.
  if (!record?.reviewed_input || Object.hasOwn(record.reviewed_input, "scenario") ||
      Object.hasOwn(record.reviewed_input, "output_formats") || input.scenario !== "GENERAL_REVIEW" ||
      JSON.stringify(input.output_formats) !== '["json"]') return false;
  const legacy = clone(input);
  delete legacy.scenario;
  delete legacy.output_formats;
  return matchesFingerprint(record.request_fingerprint, legacy);
}

function event(record, eventType, payload = {}, actor = "core-agent") {
  const trace = {
    request_id: record.request_id,
    task_id: record.task_id,
    session_id: record.session_id || null,
    run_id: record.run_id,
    audit_id: record.audit.audit_id,
    handoff_id: record.risk_handoff?.handoff_id || null
  };
  record.audit.events.push({
    event_id: id("event-"),
    task_id: record.task_id,
    actor,
    event_type: eventType,
    payload: { ...clone(payload), ...trace, trace },
    timestamp: now()
  });
}

function proposalPayload(input, review) {
  return {
    proposed_action: review.model_response?.proposal?.proposed_action || null,
    action_reason: review.model_response?.proposal?.action_reason || null,
    risk_level: review.model_response?.proposal?.risk_level || "unknown",
    requested_action: input.requested_action || null,
    action_parameters: input.action_parameters || {},
    model_response_id: review.model_response?.provider_response_id || null
  };
}

function isApprovalRequired(proposal) {
  return proposal.proposed_action !== "NO_ACTION";
}

function completeErrorRecord(error, input, taskId, runId, auditId) {
  const record = {
    workflow_version: WORKFLOW_VERSION,
    schema_version: modelReview.REVIEW_VERSION,
    task_id: taskId,
    request_id: input.request_id || null,
    session_id: input.session_id || id("session-"),
    source_task_id: input.source_task_id || null,
    data_mode: input.data_mode || "FIXTURE",
    execution_mode: input.execution_mode || "PAPER",
    capability: input.capability || "REVIEW_ONLY",
    portfolio_snapshot_id: input.portfolio_snapshot_id || null,
    risk_profile_version: input.risk_profile_version || "risk-profile.v1",
    plan_id: input.plan_id || null,
    plan_hash: null,
    policy_version: input.policy_version || "risk-policy.v1",
    idempotency_key: input.idempotency_key || null,
    request_fingerprint: null,
    memory_consent: input.memory_consent === true,
    memory_write_status: input.memory_consent === true ? "PENDING" : "NOT_REQUESTED",
    run_id: runId,
    reviewed_input: clone(input),
    status: "MODEL_FAILED",
    model: { status: "FAILED", response: null },
    proposed_action: null,
    risk_handoff: {
      contract_version: modelReview.REVIEW_VERSION,
      handoff_id: id("handoff-"),
      task_id: taskId,
      run_id: runId,
      owner: "Unified Risk",
      evidence: { audit_id: auditId, model_response_id: null, proposal_sha256: null },
      status: "BLOCKED",
      decision: "MODEL_FAILED",
      execution_allowed: false,
      reason: "模型调用失败，不能交给 Risk 或执行端。"
    },
    risk_decision: null,
    approval: { approval_id: id("approval-"), task_id: taskId, proposal_sha256: null, required: true, status: "BLOCKED", decision: null, expires_at: null },
    execution: { execution_id: null, task_id: taskId, status: "BLOCKED", simulation_allowed: false, execution_allowed: false, receipt: null },
    audit: {
      audit_id: auditId,
      workflow_version: WORKFLOW_VERSION,
      task_id: taskId,
      request_id: input.request_id || null,
      run_id: runId,
      events: []
    },
    error: { code: error.code || "MODEL_FAILED", message: error.message || "model failed", retryable: Boolean(error.retryable) }
  };
  event(record, "task.created", { stage: "MODEL" });
  record.audit.events.at(-1).timestamp = error.reviewRecord?.created_at || now();
  for (const retry of error.reviewRecord?.audit?.events || []) {
    if (retry.event_type !== "model.retry_scheduled") continue;
    const { event_type, at, ...payload } = retry;
    event(record, event_type, payload, "model-service");
    record.audit.events.at(-1).timestamp = at || now();
  }
  event(record, "model.failed", { ...record.error, attempt_count: error.reviewRecord?.attempt_count, retry_count: error.reviewRecord?.retry_count });
  event(record, "risk.blocked", { reason: "model_failed" }, "risk-gateway");
  event(record, "execution.blocked", { reason: "model_failed" }, "execution-gateway");
  return record;
}

class ReviewWorkflowStore {
  constructor({ modelRunner = modelReview.runReview, fundingPlans = new FundingPlanStore(), memoryWriter = null, approvalTtlMs = APPROVAL_TTL_MS } = {}) {
    this.modelRunner = modelRunner;
    this.fundingPlans = fundingPlans;
    this.memoryWriter = memoryWriter;
    this.approvalTtlMs = Number.isFinite(approvalTtlMs) && approvalTtlMs > 0 ? approvalTtlMs : APPROVAL_TTL_MS;
    this.records = new Map();
    this.byTask = new Map();
    this.byIdempotency = new Map();
    this.startingTasks = new Set();
    this.startingIdempotency = new Map();
    this.dispatchingTasks = new Map();
  }

  save(record) {
    const snapshot = clone(record);
    this.records.set(snapshot.run_id, snapshot);
    this.byTask.set(snapshot.task_id, snapshot.run_id);
    if (snapshot.idempotency_key) this.byIdempotency.set(snapshot.idempotency_key, snapshot.run_id);
    return clone(snapshot);
  }

  getByRunId(runId) {
    const record = this.records.get(runId);
    return record ? clone(record) : null;
  }

  getByTaskId(taskId) {
    const runId = this.byTask.get(taskId);
    return runId ? this.getByRunId(runId) : null;
  }

  async start(input = {}, env = {}, options = {}) {
    input = modelReview.normalizeReviewInput(input);
    const taskId = input.task_id || id("review-task-");
    // Join an in-flight request before consulting the completed-record index.
    // A reused key must never cause a second inference while the first is pending.
    const pending = input.idempotency_key && this.startingIdempotency.get(input.idempotency_key);
    if (pending) {
      try { await pending; } catch (error) {
        if (!this.byIdempotency.has(input.idempotency_key)) throw error;
      }
    }
    if (input.idempotency_key && this.byIdempotency.has(input.idempotency_key)) {
      const existing = this.getByRunId(this.byIdempotency.get(input.idempotency_key));
      if (await matchesRequestFingerprint(existing, input)) return existing;
      throw new WorkflowError("IDEMPOTENCY_CONFLICT", "idempotency key is already bound to different review input", {
        statusCode: 409, stage: "VALIDATION", recovery: "Reuse the original request body or create a new idempotency key.", record: existing
      });
    }
    if (this.byTask.has(taskId) || this.startingTasks.has(taskId)) {
      throw new WorkflowError("TASK_ALREADY_EXISTS", "task_id already exists; load its record or create a new task", { stage: "VALIDATION", record: this.getByTaskId(taskId) });
    }
    this.startingTasks.add(taskId);
    const work = this.startNew(input, taskId, env, options);
    if (input.idempotency_key) this.startingIdempotency.set(input.idempotency_key, work);
    try {
      return await work;
    } finally {
      this.startingTasks.delete(taskId);
      if (this.startingIdempotency.get(input.idempotency_key) === work) this.startingIdempotency.delete(input.idempotency_key);
    }
  }

  async startNew(input, taskId, env, options) {
    // Idempotency binds the caller's normalized request, not the funding context
    // added below for model review. Keep that identity for success and failure.
    const requestInput = clone(input);
    const requestId = input.request_id || id("req-");
    const sessionId = input.session_id || id("session-");
    const modelInput = { ...input, task_id: taskId, request_id: requestId, session_id: sessionId };
    const funding = this.fundingPlans.bind(modelInput.action_parameters);
    if (funding) modelInput.context = { ...modelInput.context, demo_funding_snapshot: {
      ...funding, check: this.fundingPlans.check(funding), instruction_authority: false
    } };
    const runId = id("review-");
    let review;
    try {
      review = await this.modelRunner(modelInput, env, options);
    } catch (error) {
      const failed = completeErrorRecord(error, modelInput, taskId, error.reviewRecord?.run_id || runId, error.reviewRecord?.audit?.audit_id || error.auditId || id("audit-"));
      failed.request_fingerprint = await fingerprint(requestInput);
      if (error.reviewRecord) {
        failed.model.response = clone(error.reviewRecord);
        failed.model.status = "FAILED";
      }
      this.save(failed);
      error.workflowRecord = clone(failed);
      error.taskId = taskId;
      error.runId = failed.run_id;
      error.auditId = failed.audit?.audit_id || error.auditId;
      throw error;
    }

    const proposal = proposalPayload(modelInput, review);
    if (funding) proposal.funding = funding;
    const proposalSha256 = await hash(proposal);
    const planId = modelInput.plan_id || id("plan-");
    const approvalRequired = Boolean(funding) || isApprovalRequired(proposal);
    const record = {
      workflow_version: WORKFLOW_VERSION,
      schema_version: modelInput.schema_version,
      task_id: taskId,
      request_id: requestId,
      session_id: sessionId,
      source_task_id: modelInput.source_task_id,
      data_mode: modelInput.data_mode,
      execution_mode: modelInput.execution_mode,
      capability: modelInput.capability,
      scenario: modelInput.scenario,
      output_contract: clone(review.output_contract),
      portfolio_snapshot_id: modelInput.portfolio_snapshot_id,
      risk_profile_version: modelInput.risk_profile_version,
      plan_id: planId,
      plan_hash: proposalSha256,
      policy_version: modelInput.policy_version,
      idempotency_key: modelInput.idempotency_key,
      request_fingerprint: await fingerprint(requestInput),
      memory_consent: modelInput.memory_consent === true,
      memory_write_status: modelInput.memory_consent === true ? "PENDING" : "NOT_REQUESTED",
      run_id: review.run_id,
      status: "PENDING_RISK",
      reviewed_input: clone(modelInput),
      model: {
        status: review.status,
        source: review.source,
        model_response: review.model_response,
        input: review.input
      },
      proposed_action: { ...proposal, proposal_sha256: proposalSha256 },
      risk_handoff: {
        contract_version: modelReview.REVIEW_VERSION,
        handoff_id: id("handoff-"),
        task_id: taskId,
        run_id: review.run_id,
        status: "PENDING_REVIEW",
        decision: "REQUIRED",
        owner: "Unified Risk",
        reason: "模型输出只是拟议动作，必须由统一 Risk 决定是否进入审批。",
        evidence: {
          input_sha256: review.input.input_sha256,
          model_response_id: review.model_response.provider_response_id || null,
          proposal_sha256: proposalSha256,
          audit_id: review.audit.audit_id,
          plan_id: planId,
          plan_hash: proposalSha256,
          policy_version: modelInput.policy_version
        },
        execution_allowed: false
      },
      risk_decision: null,
      approval: {
        approval_id: id("approval-"),
        task_id: taskId,
        required: approvalRequired,
        status: approvalRequired ? "BLOCKED" : "NOT_REQUIRED",
        decision: null,
        proposal_sha256: proposalSha256,
        approver: null,
        decided_at: null,
        expires_at: null
      },
      execution: {
        execution_id: null,
        task_id: taskId,
        status: "BLOCKED",
        simulation_allowed: false,
        execution_allowed: false,
        receipt: null
      },
      audit: {
        audit_id: review.audit.audit_id,
        workflow_version: WORKFLOW_VERSION,
        task_id: taskId,
        request_id: requestId,
        run_id: review.run_id,
        events: []
      }
    };
    for (const prior of review.audit.events || []) {
      const { event_type, at, timestamp, ...payload } = prior;
      event(record, event_type, payload, "model-service");
      record.audit.events.at(-1).timestamp = timestamp || at || now();
    }
    event(record, "workflow.created", { stage: "MODEL" });
    if (funding) {
      record.funding_check = this.fundingPlans.check(funding);
      event(record, "funding.bound", { funding, check: record.funding_check }, "funding-guard");
    }
    event(record, "proposal.bound", { source: review.source, proposal_sha256: proposalSha256 });
    event(record, "risk.handoff.created", { handoff_id: record.risk_handoff.handoff_id }, "risk-gateway");
    event(record, "execution.blocked", { reason: "risk_pending", execution_allowed: false }, "execution-gateway");
    if (record.memory_consent) event(record, "memory.write.pending", { status: record.memory_write_status }, "memory");
    return this.save(record);
  }

  requireRecord(taskId) {
    const record = this.getByTaskId(taskId);
    if (!record) throw new WorkflowError("WORKFLOW_NOT_FOUND", "review task not found", { statusCode: 404, stage: "LOOKUP", recovery: "Use the task_id returned by POST /api/review." });
    return record;
  }

  expireApproval(record) {
    const expiresAt = Date.parse(record.approval?.expires_at || "");
    // Approval does not extend its deadline. Completed tasks keep their receipt.
    if (!record.approval?.required || !["PENDING", "APPROVED"].includes(record.approval.status) ||
        !["PENDING_APPROVAL", "READY_FOR_SIMULATION"].includes(record.status) ||
        !Number.isFinite(expiresAt) || expiresAt > Date.now()) return false;
    record.approval.status = "EXPIRED";
    record.status = "EXPIRED";
    record.execution.status = "BLOCKED";
    record.execution.simulation_allowed = false;
    record.execution.execution_allowed = false;
    event(record, "approval.expired", { approval_id: record.approval.approval_id, expires_at: record.approval.expires_at }, "approval-gateway");
    event(record, "execution.blocked", { reason: "approval_expired" }, "execution-gateway");
    this.save(record);
    return true;
  }

  deny(record, code, message, stage, recovery, statusCode = 409) {
    event(record, "workflow.operation_blocked", { code, stage, execution_allowed: false }, "execution-gateway");
    const saved = this.save(record);
    throw new WorkflowError(code, message, { statusCode, stage, recovery, record: saved });
  }

  hasSimulationCapability(record) {
    return record.capability === "SIMULATION_ONLY" &&
      record.reviewed_input?.capability === "SIMULATION_ONLY";
  }

  requireSimulationCapability(record, stage) {
    if (this.hasSimulationCapability(record)) return;
    record.execution.simulation_allowed = false;
    record.execution.execution_allowed = false;
    record.execution.status = "BLOCKED";
    if (record.status === "READY_FOR_SIMULATION") record.status = "PENDING_APPROVAL";
    this.deny(record, "SIMULATION_CAPABILITY_REQUIRED", "Only an explicitly reviewed SIMULATION_ONLY task may enter simulation", stage,
      "Create a new SIMULATION_ONLY task and repeat Risk and approval; approval cannot upgrade a REVIEW_ONLY task.");
  }

  decisionInput(record, input, decisions, actorField, stage) {
    this.checkInput(record, input, ["task_id", "proposal_sha256", "decision", actorField, "reason"], stage);
    try {
      return { decision: decisionValue(input.decision, decisions, "decision"),
        actor: requiredString(input[actorField], actorField), reason: requiredString(input.reason, "reason") };
    } catch (error) {
      if (!(error instanceof WorkflowError)) throw error;
      this.deny(record, error.code, error.message, stage, error.recovery, error.statusCode);
    }
  }

  checkInput(record, input, allowed, stage) {
    if (Object.keys(input).some(key => !allowed.includes(key))) {
      this.deny(record, "UNEXPECTED_ACTION_FIELDS", "decision and execution endpoints cannot change action parameters", stage, "Create a new task for changed parameters.");
    }
    if (input.proposal_sha256 !== record.proposed_action.proposal_sha256) {
      this.deny(record, "PROPOSAL_CHANGED", "proposal hash does not match the task", stage, "Reload and review the current proposal.");
    }
  }

  async receiveRiskCallback(input = {}, actorAuth = null) {
    const record = this.requireRecord(requiredString(input.task_id, "task_id"));
    let callback;
    try {
      callback = riskHandoff.validateRiskCallback(input, record);
    } catch (error) {
      event(record, "risk.callback.blocked", { code: error.code, execution_allowed: false }, "risk-gateway");
      error.workflowRecord = this.save(record);
      throw error;
    }
    if (record.risk_callback) {
      if (JSON.stringify(record.risk_callback.request) === JSON.stringify(callback)) {
        return { callback_status: "DUPLICATE", workflow: record };
      }
      this.deny(record, "RISK_CALLBACK_CONFLICT", "A different callback is already recorded for this handoff", "RISK_CALLBACK", "Read the existing decision. Create a new task for a changed proposal.");
    }
    if (record.risk_decision) {
      this.deny(record, "RISK_DECISION_IMMUTABLE", "A Risk decision already exists; callback cannot replace it", "RISK_CALLBACK", "Read the existing decision or create a new task.");
    }
    const { task_id, proposal_sha256, decision, reviewer, reason } = callback;
    // Do not yield between recording Risk and its callback receipt. A cancellation
    // or duplicate callback must observe both changes, never an intermediate state.
    const result = this.applyRiskDecision({ task_id, proposal_sha256, decision, reviewer, reason }, actorAuth);
    result.risk_callback = { callback_version: riskHandoff.CALLBACK_VERSION, request: callback, received_at: now(), ...(actorAuth ? { auth: clone(actorAuth) } : {}) };
    event(result, "risk.callback.recorded", {
      handoff_id: callback.handoff_id, audit_id: callback.audit_id,
      proposal_sha256, decision, risk_decision_id: result.risk_decision.risk_decision_id
    }, "risk-gateway");
    return { callback_status: "RECORDED", workflow: this.save(result) };
  }

  async dispatchRiskHandoff(input = {}, sender) {
    const taskId = requiredString(input.task_id, "task_id");
    const record = this.requireRecord(taskId);
    if (!record.proposed_action) throw new WorkflowError("RISK_BLOCKED", "model failure cannot be dispatched to Risk", { stage: "RISK_DISPATCH", record });
    this.checkInput(record, input, ["task_id", "proposal_sha256"], "RISK_DISPATCH");
    if (record.risk_dispatch?.status === "SENT") return record;
    if (record.status !== "PENDING_RISK") {
      this.deny(record, "RISK_DISPATCH_BLOCKED", "only a task waiting for Risk can be dispatched", "RISK_DISPATCH", "Read the current task state and create a new task if the proposal changed.");
    }
    if (typeof sender !== "function") {
      this.deny(record, "RISK_OWNER_NOT_CONFIGURED", "Risk Owner adapter is not configured", "RISK_DISPATCH", "Configure the Risk service address and HMAC secret before dispatching.", 503);
    }
    if (this.dispatchingTasks.has(taskId)) return clone(await this.dispatchingTasks.get(taskId));
    const work = this.sendRiskHandoff(record, sender);
    this.dispatchingTasks.set(taskId, work);
    try { return await work; }
    finally {
      if (this.dispatchingTasks.get(taskId) === work) this.dispatchingTasks.delete(taskId);
    }
  }

  async sendRiskHandoff(record, sender) {
    const taskId = record.task_id;
    try {
      const handoff = riskHandoff.buildRiskHandoffPackage(record);
      const result = await sender(handoff, record);
      // A callback, cancellation or approval may have completed during I/O.
      // Only attach delivery evidence to the latest record; never save the stale snapshot.
      record = this.requireRecord(taskId);
      record.risk_dispatch = {
        dispatch_id: record.risk_dispatch?.dispatch_id || id("risk-dispatch-"),
        status: "SENT",
        attempts: (record.risk_dispatch?.attempts || 0) + 1,
        sent_at: now(),
        upstream_status: result?.upstream_status || null
      };
      event(record, "risk.handoff.dispatched", { dispatch_id: record.risk_dispatch.dispatch_id, upstream_status: record.risk_dispatch.upstream_status }, "risk-gateway");
      return this.save(record);
    } catch (error) {
      record = this.requireRecord(taskId);
      record.risk_dispatch = {
        dispatch_id: record.risk_dispatch?.dispatch_id || id("risk-dispatch-"),
        status: "FAILED",
        attempts: (record.risk_dispatch?.attempts || 0) + 1,
        failed_at: now(),
        error_code: error.code || "RISK_DISPATCH_FAILED"
      };
      event(record, "risk.handoff.dispatch_failed", { dispatch_id: record.risk_dispatch.dispatch_id, code: record.risk_dispatch.error_code }, "risk-gateway");
      const wrapped = error instanceof WorkflowError ? error : new WorkflowError(error.code || "RISK_DISPATCH_FAILED", error.message || "Risk Handoff dispatch failed", {
        statusCode: error.statusCode || 503,
        retryable: Boolean(error.retryable),
        stage: error.stage || "RISK_DISPATCH",
        recovery: error.recovery || "确认 Risk Owner 服务状态后重试。",
        details: error.details || null,
        record: this.save(record)
      });
      wrapped.workflowRecord = this.save(record);
      throw wrapped;
    }
  }

  async decideRisk(input = {}, actorAuth = null) {
    return this.applyRiskDecision(input, actorAuth);
  }

  applyRiskDecision(input = {}, actorAuth = null) {
    const taskId = requiredString(input.task_id, "task_id");
    const record = this.requireRecord(taskId);
    if (!record.proposed_action) throw new WorkflowError("RISK_BLOCKED", "model failure cannot be approved", { stage: "RISK", record });
    const { decision, actor: reviewer, reason } = this.decisionInput(record, input, RISK_DECISIONS, "reviewer", "RISK");
    this.expireApproval(record);
    if (["SIMULATED", "REJECTED", "EXPIRED", "MODEL_FAILED", "FUNDING_BLOCKED", "CANCELLED"].includes(record.status)) {
      this.deny(record, "WORKFLOW_TERMINAL", "this task is terminal and cannot receive another Risk decision", "RISK", "Create a new task for a new proposal.");
    }
    if (record.risk_decision?.decision) {
      if (record.risk_decision.decision === decision && record.risk_decision.reviewer === reviewer && record.risk_decision.reason === reason) return record;
      this.deny(record, "RISK_DECISION_IMMUTABLE", "Risk retry must match the recorded decision, reviewer and reason", "RISK", "Read the existing decision. Changed evidence requires a new task and review.");
    }
    record.risk_decision = {
      risk_decision_id: record.risk_decision?.risk_decision_id || id("risk-decision-"),
      task_id: taskId,
      decision,
      status: decision === "APPROVE" ? "APPROVED" : decision === "REJECT" ? "REJECTED" : "PENDING_REVIEW",
      reviewer,
      reason,
      proposal_sha256: record.proposed_action.proposal_sha256,
      decided_at: now(),
      ...(actorAuth ? { auth: clone(actorAuth) } : {})
    };
    record.risk_handoff.status = record.risk_decision.status === "APPROVED" ? "APPROVED" : record.risk_decision.status === "REJECTED" ? "REJECTED" : "PENDING_REVIEW";
    record.risk_handoff.decision = decision;
    record.risk_handoff.execution_allowed = false;
    if (decision === "REJECT") {
      record.status = "REJECTED";
      record.approval.status = "BLOCKED";
      record.execution.status = "BLOCKED";
      record.execution.simulation_allowed = false;
      event(record, "risk.rejected", { reason: record.risk_decision.reason }, "risk");
      event(record, "execution.blocked", { reason: "risk_rejected" }, "execution-gateway");
    } else if (decision === "REQUEST_MORE_INFO") {
      record.status = "PENDING_RISK";
      event(record, "risk.more_info_requested", { reason: record.risk_decision.reason }, "risk");
      event(record, "execution.blocked", { reason: "risk_more_info" }, "execution-gateway");
    } else {
      const canSimulate = this.hasSimulationCapability(record);
      record.status = record.approval.required || !canSimulate ? "PENDING_APPROVAL" : "READY_FOR_SIMULATION";
      record.approval.status = record.approval.required ? "PENDING" : "NOT_REQUIRED";
      record.approval.expires_at = record.approval.required ? new Date(Date.now() + this.approvalTtlMs).toISOString() : null;
      record.execution.status = record.approval.required || !canSimulate ? "BLOCKED" : "READY";
      record.execution.simulation_allowed = canSimulate && !record.approval.required;
      event(record, "risk.approved", { approval_required: record.approval.required }, "risk");
      if (record.approval.required) event(record, "approval.pending", { approval_id: record.approval.approval_id }, "approval-gateway");
      else if (canSimulate) event(record, "execution.ready_for_simulation", {}, "execution-gateway");
      else event(record, "execution.blocked", { reason: "simulation_capability_required", execution_allowed: false }, "execution-gateway");
    }
    return this.save(record);
  }

  async decideApproval(input = {}, actorAuth = null) {
    const taskId = requiredString(input.task_id, "task_id");
    const record = this.requireRecord(taskId);
    if (!record.proposed_action) throw new WorkflowError("APPROVAL_BLOCKED", "model failure cannot be approved", { stage: "APPROVAL", record });
    const { decision, actor: approver, reason } = this.decisionInput(record, input, APPROVAL_DECISIONS, "approver", "APPROVAL");
    if (this.expireApproval(record)) {
      throw new WorkflowError("APPROVAL_EXPIRED", "approval window has expired; the proposal must be reviewed again", {
        stage: "APPROVAL", recovery: "Create a new task so Risk and approval use a fresh plan version.", record: this.getByTaskId(taskId)
      });
    }
    if (["SIMULATED", "REJECTED", "EXPIRED", "MODEL_FAILED", "FUNDING_BLOCKED", "CANCELLED"].includes(record.status)) {
      this.deny(record, "WORKFLOW_TERMINAL", "this task is terminal and cannot receive another approval", "APPROVAL", "Create a new task for a new proposal.");
    }
    if (record.risk_decision?.decision !== "APPROVE" || record.risk_decision.status !== "APPROVED") {
      throw new WorkflowError("APPROVAL_BLOCKED", "approval requires an approved Risk decision", { stage: "APPROVAL", recovery: "Wait for Risk APPROVE before recording approval.", record });
    }
    if (!record.approval.required) throw new WorkflowError("APPROVAL_NOT_REQUIRED", "this task does not require approval", { stage: "APPROVAL", record });
    if (decision === "APPROVE") this.requireSimulationCapability(record, "APPROVAL");
    if (record.approval.status !== "PENDING") {
      if (record.approval.decision === decision && record.approval.approver === approver && record.approval.reason === reason) return record;
      this.deny(record, "APPROVAL_IMMUTABLE", "Approval retry must match the recorded decision, approver and reason", "APPROVAL", "Read the existing approval. Changed evidence requires a new task and review.");
    }
    record.approval.decision = decision;
    record.approval.reason = reason;
    record.approval.approver = approver;
    record.approval.decided_at = now();
    if (actorAuth) record.approval.auth = clone(actorAuth);
    record.approval.status = decision === "APPROVE" ? "APPROVED" : "REJECTED";
    if (decision === "REJECT") {
      record.status = "REJECTED";
      record.execution.status = "BLOCKED";
      record.execution.simulation_allowed = false;
      event(record, "approval.rejected", { reason }, "approval");
      event(record, "execution.blocked", { reason: "approval_rejected" }, "execution-gateway");
    } else {
      record.status = "READY_FOR_SIMULATION";
      record.execution.status = "READY";
      record.execution.simulation_allowed = true;
      record.approval.expires_at = record.approval.expires_at || new Date(Date.now() + this.approvalTtlMs).toISOString();
      event(record, "approval.approved", { approval_id: record.approval.approval_id }, "approval");
      event(record, "execution.ready_for_simulation", {}, "execution-gateway");
    }
    return this.save(record);
  }

  async simulate(input = {}) {
    const taskId = requiredString(input.task_id, "task_id");
    let record = this.requireRecord(taskId);
    if (!record.proposed_action) throw new WorkflowError("EXECUTION_BLOCKED", "model failure cannot be simulated", { stage: "EXECUTION", record });
    this.checkInput(record, input, ["task_id", "proposal_sha256"], "EXECUTION");
    const { proposal_sha256, ...boundProposal } = record.proposed_action;
    if (await hash(boundProposal) !== proposal_sha256) this.deny(record, "PROPOSAL_CHANGED", "stored proposal integrity check failed", "EXECUTION", "Create a new task and repeat Risk and approval.");
    // Re-read after the asynchronous hash so concurrent retries cannot mint two receipts.
    record = this.requireRecord(taskId);
    if (record.status === "SIMULATED") return record;
    if (this.expireApproval(record)) {
      throw new WorkflowError("APPROVAL_EXPIRED", "approval window has expired; simulation is blocked", {
        stage: "EXECUTION", recovery: "Create a new task so Risk and approval use a fresh plan version.", record: this.getByTaskId(taskId)
      });
    }
    if (record.risk_decision?.decision !== "APPROVE" || record.risk_decision?.proposal_sha256 !== proposal_sha256 ||
        (record.approval.required && (record.approval.status !== "APPROVED" || record.approval.proposal_sha256 !== proposal_sha256))) {
      this.deny(record, "EXECUTION_BLOCKED", "Risk and required approval must refer to this exact proposal", "EXECUTION", "Complete Risk and approval first.");
    }
    if (record.status !== "READY_FOR_SIMULATION" || !record.execution.simulation_allowed) {
      event(record, "execution.blocked", { reason: record.status.toLowerCase(), execution_allowed: false }, "execution-gateway");
      const saved = this.save(record);
      throw new WorkflowError("EXECUTION_BLOCKED", "execution is blocked until Risk and approval are complete", { stage: "EXECUTION", recovery: "Resolve the Risk and approval states, then retry simulation.", record: saved });
    }
    this.requireSimulationCapability(record, "EXECUTION");
    const executionId = id("sim-exec-");
    let allocation = null;
    if (record.proposed_action.funding) {
      try {
        const reserved = this.fundingPlans.allocate(record.proposed_action.funding, taskId, proposal_sha256, executionId);
        allocation = reserved.allocation;
        record.funding_check = reserved.check;
        event(record, "funding.allocated", allocation, "funding-guard");
      } catch (error) {
        record.funding_check = error.details || { status: "BLOCKED", code: error.code, message: error.message };
        record.execution.status = "BLOCKED";
        record.execution.simulation_allowed = false;
        record.status = "FUNDING_BLOCKED";
        event(record, "funding.blocked", { code: error.code, check: record.funding_check }, "funding-guard");
        error.workflowRecord = this.save(record);
        throw error;
      }
    }
    record.execution = {
      execution_id: executionId,
      task_id: taskId,
      status: "SIMULATED",
      simulation_allowed: false,
      execution_allowed: false,
      receipt: {
        mode: "SIMULATED",
        execution_id: executionId,
        task_id: taskId,
        proposal_sha256: record.proposed_action.proposal_sha256,
        side_effects: false,
        ...(allocation ? { funding_allocation: allocation } : {}),
        message: "模拟执行完成；未调用真实交易、付款或账户网关。",
        completed_at: now()
      }
    };
    record.status = "SIMULATED";
    event(record, "execution.simulated", { execution_id: executionId, side_effects: false }, "execution-gateway");
    // Publish the receipt in this store before yielding to an optional writer.
    // Persistent adapters still own their storage commit; this is not a disk flush.
    this.save(record);
    await this.writeMemory(record);
    return this.requireRecord(taskId);
  }

  async writeMemory(record) {
    if (record.memory_consent !== true) return record;
    if (typeof this.memoryWriter !== "function") {
      record.memory_write_status = "UNAVAILABLE";
      event(record, "memory.write.blocked", { reason: "memory_writer_not_configured" }, "memory");
      return this.save(record);
    }
    try {
      const entry = await this.memoryWriter(record.session_id, {
        type: "decision",
        key: "review:" + record.task_id,
        value: { task_id: record.task_id, plan_id: record.plan_id, proposal_sha256: record.proposed_action.proposal_sha256, status: record.status },
        consent: true
      });
      // Retain audit events appended while the writer was pending.
      record = this.requireRecord(record.task_id);
      record.memory_write_status = "WRITTEN";
      record.memory_id = entry?.memory_id || null;
      event(record, "memory.saved", { memory_id: record.memory_id, status: record.memory_write_status }, "memory");
    } catch (error) {
      record = this.requireRecord(record.task_id);
      record.memory_write_status = "FAILED";
      event(record, "memory.write.failed", { code: error.code || "MEMORY_WRITE_FAILED", message: error.message }, "memory");
    }
    return this.save(record);
  }

  async cancel(input = {}) {
    const taskId = requiredString(input.task_id, "task_id");
    const record = this.requireRecord(taskId);
    if (!record.proposed_action) throw new WorkflowError("CANCELLATION_BLOCKED", "没有可取消的模型任务", { stage: "CANCELLATION", record });
    const canceler = requiredString(input.canceler, "canceler");
    const reason = requiredString(input.reason, "reason");
    this.checkInput(record, input, ["task_id", "proposal_sha256", "canceler", "reason"], "CANCELLATION");
    if (["SIMULATED", "REJECTED", "EXPIRED", "MODEL_FAILED", "FUNDING_BLOCKED", "CANCELLED"].includes(record.status)) {
      this.deny(record, "WORKFLOW_TERMINAL", "this task is terminal and cannot be cancelled again", "CANCELLATION", "Read the existing record. Create a new task if needed.");
    }
    record.status = "CANCELLED";
    record.approval.status = "BLOCKED";
    record.execution.status = "BLOCKED";
    record.execution.simulation_allowed = false;
    record.execution.execution_allowed = false;
    record.risk_handoff.status = "BLOCKED";
    record.risk_handoff.decision = "CANCELLED";
    record.risk_handoff.execution_allowed = false;
    record.cancellation = { canceler, reason, cancelled_at: now(), proposal_sha256: record.proposed_action.proposal_sha256 };
    event(record, "task.cancelled", { canceler, reason, execution_allowed: false }, "user");
    event(record, "execution.blocked", { reason: "task_cancelled" }, "execution-gateway");
    return this.save(record);
  }

  reset() {
    this.records.clear();
    this.byTask.clear();
    this.byIdempotency.clear();
    this.startingTasks.clear();
    this.startingIdempotency.clear();
    this.dispatchingTasks.clear();
  }
}

module.exports = { WORKFLOW_VERSION, RISK_DECISIONS, APPROVAL_DECISIONS, WorkflowError, ReviewWorkflowStore, fingerprint, matchesFingerprint, matchesRequestFingerprint };
