"use strict";

const crypto = require("node:crypto");
const { MemoryStore } = require("./memory");
const financialTools = require("../tools/financial-tools");
const marketBrief = require("../tools/market-brief");
const contract = require("../contracts/investment-contract");

const REQUIRED_RISK_FIELDS = ["investment_horizon_days", "max_drawdown", "liquidity_need"];
const OWNED_STAGES = ["VALIDATE_INPUT", "DIAGNOSE", "GENERATE_CANDIDATES", "SIMULATE"];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function id(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function missingRiskFields(riskProfile) {
  return REQUIRED_RISK_FIELDS.filter((field) => riskProfile === null || riskProfile === undefined || riskProfile[field] === undefined || riskProfile[field] === null || riskProfile[field] === "");
}

class Harness {
  constructor({ toolset = financialTools, memory = new MemoryStore(), owner_id: defaultOwnerId = null } = {}) {
    this.toolset = toolset;
    this.memory = memory;
    this.defaultOwnerId = typeof defaultOwnerId === "string" && defaultOwnerId.trim() ? defaultOwnerId.trim() : null;
    this.tasks = new Map();
  }

  createSession({ intent = "PORTFOLIO_HEALTH_CHECK", risk_profile: riskProfile = null, owner_id: ownerId = this.defaultOwnerId } = {}) {
    this.validateProfile(riskProfile);
    const sessionId = id("session");
    const taskId = id("task");
    const normalizedOwnerId = typeof ownerId === "string" && ownerId.trim() ? ownerId.trim() : null;
    if (normalizedOwnerId) this.memory.registerSession(sessionId, { owner_id: normalizedOwnerId });
    const missingFields = missingRiskFields(riskProfile);
    const state = {
      task_id: taskId,
      session_id: sessionId,
      owner_id: normalizedOwnerId,
      contract_version: contract.CONTRACT_VERSION,
      request_id: null,
      intent,
      stage: missingFields.length ? "MINIMUM_CLARIFICATION" : "VALIDATE_INPUT",
      status: missingFields.length ? "WAITING_INPUT" : "READY",
      risk_profile: clone(riskProfile),
      missing_fields: missingFields,
      portfolio_snapshot_id: null,
      risk_profile_id: riskProfile ? `risk-profile-${crypto.randomUUID()}` : null,
      tool_result_refs: [],
      proposed_action_ids: [],
      risk_decision_id: null,
      approval_id: null,
      error_state: null,
      checkpoint: {
        stage: missingFields.length ? "MINIMUM_CLARIFICATION" : "VALIDATE_INPUT",
        completed: [],
        result_refs: {},
        resume_token: id("resume")
      }
    };
    const task = { state, artifacts: {}, events: [], failures: {}, results: {} };
    this.tasks.set(taskId, task);
    this.addEvent(task, "session.created", { missing_fields: missingFields });
    return this.getTask(taskId);
  }

  getTask(taskId) {
    const task = this.tasks.get(taskId);
    return task ? clone({
      task_state: task.state,
      artifacts: task.artifacts,
      tool_results: task.results,
      audit_evidence: this.buildAuditEvidence(task)
    }) : null;
  }

  validateProfile(profile) {
    if (profile == null) return;
    if (typeof profile !== "object" || Array.isArray(profile)) throw new Error("risk_profile must be an object");
    if (profile.max_drawdown !== undefined && (!Number.isFinite(profile.max_drawdown) || profile.max_drawdown <= 0 || profile.max_drawdown > 1))
      throw new Error("max_drawdown must be between 0 and 1");
    if (profile.investment_horizon_days !== undefined && (!Number.isInteger(profile.investment_horizon_days) || profile.investment_horizon_days <= 0))
      throw new Error("investment_horizon_days must be a positive integer");
    if (profile.liquidity_need !== undefined && !["low", "medium", "high"].includes(profile.liquidity_need))
      throw new Error("liquidity_need must be low, medium or high");
  }

  getAudit(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) return null;
    return clone({
      task_id: taskId,
      task_state: task.state,
      audit_evidence: this.buildAuditEvidence(task),
      events: task.events
    });
  }

  buildAuditEvidence(task) {
    return {
      audit_id: "audit-" + task.state.task_id,
      contract_version: task.state.contract_version || contract.CONTRACT_VERSION,
      request_id: task.state.request_id || null,
      task_id: task.state.task_id,
      session_id: task.state.session_id,
      events: clone(task.events)
    };
  }

  bindRequest(task, requestId) {
    if (!requestId) return;
    task.state.request_id = requestId;
    this.addEvent(task, "contract.received", { contract_version: task.state.contract_version });
  }

  decorateError(error, task, stage = error.stage || task.state.stage || "BACKEND") {
    error.requestId = error.requestId ?? task.state.request_id ?? null;
    error.taskId = error.taskId ?? task.state.task_id;
    error.sessionId = error.sessionId ?? task.state.session_id;
    error.auditId = error.auditId ?? "audit-" + task.state.task_id;
    error.stage = error.stage || stage;
    error.trace = {
      contract_version: task.state.contract_version || contract.CONTRACT_VERSION,
      request_id: error.requestId,
      task_id: error.taskId,
      session_id: error.sessionId,
      audit_id: error.auditId
    };
    return error;
  }

  addEvent(task, eventType, payload = {}) {
    task.events.push({
      event_id: id("event"),
      task_id: task.state.task_id,
      actor: "harness",
      event_type: eventType,
      payload: { ...clone(payload), request_id: task.state.request_id || null },
      timestamp: new Date().toISOString()
    });
  }

  checkpoint(task, stage, resultRef = null) {
    if (!task.state.checkpoint.completed.includes(stage)) task.state.checkpoint.completed.push(stage);
    task.state.checkpoint.stage = stage;
    task.state.checkpoint.last_tool_result_ref = resultRef;
    task.state.checkpoint.result_refs[stage] = resultRef;
  }

  runOrReuse(task, stage, artifactKey, outputFactory, operation) {
    if (task.state.checkpoint.completed.includes(stage) && task.artifacts[artifactKey]) {
      const result = {
        tool_name: `checkpoint.${stage.toLowerCase()}`,
        version: "checkpoint@1.0.0",
        inputs_hash: task.state.checkpoint.result_refs[stage] || "checkpoint",
        output: outputFactory(task),
        data_as_of: this.toolset.constants ? this.toolset.constants.DATA_AS_OF : null,
        warnings: ["result reused from checkpoint"],
        trace_id: task.state.checkpoint.result_refs[stage]
      };
      this.addEvent(task, "stage.reused", { stage, result_ref: result.trace_id });
      return result;
    }
    return this.runNode(task, stage, operation);
  }

  runNode(task, stage, operation) {
    if (!OWNED_STAGES.includes(stage)) throw new Error(`stage is outside Harness ownership: ${stage}`);
    task.state.stage = stage;
    task.state.status = "RUNNING";
    this.addEvent(task, "stage.started", { stage });
    let lastError;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const result = operation();
        const resultRef = result.trace_id || `tool-result-${crypto.randomUUID()}`;
        task.results[resultRef] = clone(result);
        task.state.tool_result_refs.push(resultRef);
        delete task.failures[stage];
        this.checkpoint(task, stage, resultRef);
        this.addEvent(task, "stage.completed", { stage, attempt, result_ref: resultRef });
        return result;
      } catch (error) {
        lastError = error;
        task.failures[stage] = (task.failures[stage] || 0) + 1;
        this.addEvent(task, "stage.failed", { stage, attempt, code: error.code || "TOOL_ERROR", message: error.message });
        if (attempt === 1) this.addEvent(task, "stage.retry_scheduled", { stage, reason: error.message });
      }
    }
    task.state.status = Object.values(task.failures).some((count) => count >= 3) ? "CIRCUIT_OPEN" : "FAILED";
    task.state.error_state = {
      code: lastError.code || "TOOL_ERROR",
      message: lastError.message,
      stage,
      retryable: false,
      recovery: "Fix the input or data source and resume from the latest checkpoint."
    };
    this.addEvent(task, "task.failed", task.state.error_state);
    throw this.decorateError(lastError, task, stage);
  }

  runHealthCheck({ task_id: taskId, session_id: sessionId, request_id: requestId, risk_profile: riskProfile, portfolio } = {}) {
    this.validateProfile(riskProfile);
    let task = taskId ? this.tasks.get(taskId) : null;
    if (taskId && !task) throw Object.assign(new Error("task not found"), { statusCode: 404 });
    if (!task) {
      const created = this.createSession({ risk_profile: riskProfile });
      task = this.tasks.get(created.task_state.task_id);
    }
    this.bindRequest(task, requestId);
    if (sessionId && task.state.session_id !== sessionId) {
      throw this.decorateError(new Error("session_id does not match task"), task, "SESSION_BINDING");
    }
    if (task.state.status === "CIRCUIT_OPEN") {
      throw this.decorateError(new Error("circuit is open; create a new task after repairing the tool"), task, "CIRCUIT_BREAKER");
    }
    const changed = (portfolio !== undefined && JSON.stringify(portfolio) !== JSON.stringify(task.inputPortfolio)) ||
      (riskProfile !== undefined && JSON.stringify(riskProfile) !== JSON.stringify(task.state.risk_profile));
    if (changed) {
      task.artifacts = {}; task.results = {}; task.state.tool_result_refs = []; task.state.proposed_action_ids = [];
      task.state.portfolio_snapshot_id = null; task.state.handoff = null;
      task.state.checkpoint.completed = []; task.state.checkpoint.result_refs = {};
      task.state.status = "READY"; task.state.error_state = null; task.failures = {};
      this.addEvent(task, "checkpoint.invalidated", { reason: "input changed" });
    }
    if (portfolio !== undefined) task.inputPortfolio = clone(portfolio);
    if (task.state.status === "HANDOFF_REQUIRED") return this.getTask(task.state.task_id);
    if (riskProfile !== undefined) {
      task.state.risk_profile = clone(riskProfile);
      task.state.risk_profile_id = riskProfile ? id("risk-profile") : null;
      task.state.missing_fields = missingRiskFields(riskProfile);
    }
    if (task.state.missing_fields.length) {
      task.state.stage = "MINIMUM_CLARIFICATION";
      task.state.status = "WAITING_INPUT";
      this.addEvent(task, "clarification.required", { missing_fields: task.state.missing_fields });
      return this.getTask(task.state.task_id);
    }

    const validation = this.runOrReuse(
      task,
      "VALIDATE_INPUT",
      "portfolio_snapshot",
      (currentTask) => ({ valid: true, snapshot: currentTask.artifacts.portfolio_snapshot }),
      () => this.toolset.validatePortfolio(task.inputPortfolio || this.toolset.getDemoPortfolio())
    );
    if (!validation.output.valid) {
      task.state.status = "BLOCKED";
      task.state.error_state = {
        code: "INVALID_PORTFOLIO",
        message: "portfolio validation failed",
        stage: "VALIDATE_INPUT",
        retryable: true,
        reasons: validation.output.errors,
        recovery: "Correct the portfolio snapshot and run validation again."
      };
      this.addEvent(task, "task.blocked", task.state.error_state);
      return this.getTask(task.state.task_id);
    }
    const snapshot = validation.output.snapshot;
    task.state.portfolio_snapshot_id = snapshot.snapshot_id;
    task.artifacts.portfolio_snapshot = snapshot;

    const diagnosis = this.runOrReuse(
      task,
      "DIAGNOSE",
      "health_report",
      (currentTask) => currentTask.artifacts.health_report,
      () => this.toolset.diagnosePortfolio(snapshot)
    );
    task.artifacts.health_report = diagnosis.output;

    const candidates = this.runOrReuse(
      task,
      "GENERATE_CANDIDATES",
      "candidates",
      (currentTask) => ({ snapshot_id: snapshot.snapshot_id, report_id: currentTask.artifacts.health_report.report_id, candidates: currentTask.artifacts.candidates }),
      () => this.toolset.generateCandidates(snapshot, diagnosis.output)
    );
    task.state.proposed_action_ids = candidates.output.candidates.map((candidate) => candidate.proposal_id);
    task.artifacts.candidates = candidates.output.candidates;

    const simulation = this.runOrReuse(
      task,
      "SIMULATE",
      "simulation",
      (currentTask) => currentTask.artifacts.simulation,
      () => this.toolset.runSimulation(snapshot, candidates.output.candidates)
    );
    task.artifacts.simulation = simulation.output;
    task.state.stage = "RISK_CHECK";
    task.state.status = "HANDOFF_REQUIRED";
    task.state.checkpoint.stage = "RISK_CHECK";
    task.state.handoff = { owner: "Safety/Risk/Eval", reason: "Risk decision is outside Agent Core and Tools ownership." };
    this.addEvent(task, "stage.handoff", task.state.handoff);
    return this.getTask(task.state.task_id);
  }

  runHealthCheckContract(request) {
    const canonicalRequest = contract.assertHealthCheckRequest(request);
    let marketContextResult = null;
    if (canonicalRequest.input.market_context) {
      marketContextResult = marketBrief.validateMarketBrief(canonicalRequest.input.market_context);
      if (!marketContextResult.valid) {
        const error = new Error("market context validation failed");
        error.code = "INVALID_MARKET_CONTEXT";
        error.statusCode = 422;
        error.details = marketContextResult;
        const task = canonicalRequest.context.task_id ? this.tasks.get(canonicalRequest.context.task_id) : null;
        if (task) {
          this.bindRequest(task, canonicalRequest.request_id);
          this.addEvent(task, "contract.rejected", { code: error.code, stage: "MARKET_CONTEXT" });
          this.decorateError(error, task, "MARKET_CONTEXT");
        } else {
          error.requestId = canonicalRequest.request_id;
        }
        throw error;
      }
    }
    let result = this.runHealthCheck({
      task_id: canonicalRequest.context.task_id || undefined,
      session_id: canonicalRequest.context.session_id || undefined,
      request_id: canonicalRequest.request_id,
      risk_profile: canonicalRequest.input.risk_profile,
      portfolio: canonicalRequest.input.portfolio || undefined
    });
    const task = this.tasks.get(result.task_state.task_id);
    if (task) {
      task.state.contract_version = canonicalRequest.contract_version;
    }
    if (marketContextResult) {
      result.artifacts.market_context = marketContextResult.output;
      result.tool_results[marketContextResult.tool_result.trace_id] = marketContextResult.tool_result;
      if (task) {
        task.artifacts.market_context = clone(marketContextResult.output);
        task.results[marketContextResult.tool_result.trace_id] = clone(marketContextResult.tool_result);
        if (!task.state.tool_result_refs.includes(marketContextResult.tool_result.trace_id)) task.state.tool_result_refs.push(marketContextResult.tool_result.trace_id);
      }
    }
    if (task) this.addEvent(task, "contract.accepted", {
      contract_version: canonicalRequest.contract_version,
      request_id: canonicalRequest.request_id
    });
    result = task ? this.getTask(task.state.task_id) : result;
    return contract.buildResponse(canonicalRequest, result);
  }

  resume(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) return null;
    if (["FAILED", "BLOCKED"].includes(task.state.status)) {
      task.state.status = "READY";
      task.state.error_state = null;
      this.addEvent(task, "task.resumed", { checkpoint: task.state.checkpoint });
    }
    return this.getTask(taskId);
  }

  saveMemory(taskId, record) {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error("task not found");
    const entry = this.memory.save(task.state.session_id, record, { owner_id: task.state.owner_id });
    this.addEvent(task, "memory.saved", { memory_id: entry.memory_id, type: entry.type });
    return entry;
  }

  listMemory(sessionId, ownerId = null) {
    return this.memory.list(sessionId, ownerId ? { owner_id: ownerId } : {});
  }

  reset() {
    this.tasks.clear();
    this.memory.reset();
  }
}

module.exports = { Harness, REQUIRED_RISK_FIELDS };
