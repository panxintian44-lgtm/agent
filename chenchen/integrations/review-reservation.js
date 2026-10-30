"use strict";

const { randomUUID, createHash } = require("node:crypto");
const { fingerprint, matchesFingerprint, WorkflowError } = require("./review-workflow");
const VERSION = "review-reservation.v1";
const taskKey = taskId => "review-reservation:task:" + taskId;
const idempotencyKey = key => "review-reservation:key:" + createHash("sha256").update(key).digest("hex");

function unavailable(reservation = null) {
  const error = new WorkflowError("REVIEW_SERVICE_UNAVAILABLE", "任务记录尚未确认保存，已阻止重复模型调用。", {
    statusCode: 503, retryable: false, stage: "BACKEND",
    recovery: "保留原 task_id 和幂等键，联系后端核查持久记录；不要换键或自动重试模型。未完成核查前不能审批或执行。"
  });
  error.requestId = reservation?.request_id || null;
  error.taskId = reservation?.task_id || null;
  error.sessionId = reservation?.session_id || null;
  return error;
}

// Internal durable reservation, not a new public workflow state or Memory rule.
// The existing ReviewService queue is the single writer for these records.
class ReviewReservations {
  constructor(storage) { this.storage = storage; }

  async byTask(taskId) { return this.storage.get(taskKey(taskId)); }

  async matchesCompleted(record, input) {
    const saved = await this.byTask(record.task_id);
    return saved?.reservation_version === VERSION && saved.state === "COMPLETED" &&
      saved.run_id === record.run_id && saved.audit_id === record.audit.audit_id &&
      await matchesFingerprint(saved.request_fingerprint, input);
  }

  async assertAvailable(input) {
    const entries = [];
    if (input.idempotency_key) entries.push(await this.storage.get(idempotencyKey(input.idempotency_key)));
    if (input.task_id) entries.push(await this.byTask(input.task_id));
    for (const existing of entries.filter(Boolean)) {
      // Reject declared foreign contexts before exposing an unresolved reservation's trace.
      if ((input.session_id && input.session_id !== existing.session_id) ||
          (input.task_id && input.task_id !== existing.task_id)) {
        throw new WorkflowError("IDEMPOTENCY_CONTEXT_MISMATCH", "idempotency key is bound to another session or task", {
          statusCode: 409, stage: "VALIDATION",
          recovery: "Use a new idempotency key for a different session or task."
        });
      }
      if (existing.reservation_version !== VERSION) throw unavailable();
      if (!await matchesFingerprint(existing.request_fingerprint, input)) {
        throw new WorkflowError("IDEMPOTENCY_CONFLICT", "请求已经登记，不能用相同任务或幂等键改换内容。", { statusCode: 409, stage: "VALIDATION" });
      }
      // Even COMPLETED without its final workflow record is an integrity failure.
      // Never guess whether a previous inference happened or release this lock by age.
      throw unavailable(existing);
    }
  }

  async reserve(input) {
    const reserved = {
      reservation_version: VERSION, state: "RESERVED",
      task_id: input.task_id || "review-task-" + randomUUID(),
      request_id: input.request_id || "req-" + randomUUID(),
      session_id: input.session_id || "session-" + randomUUID(),
      request_fingerprint: await fingerprint(input),
      idempotency_storage_key: input.idempotency_key ? idempotencyKey(input.idempotency_key) : null,
      reserved_at: new Date().toISOString()
    };
    const entries = { [taskKey(reserved.task_id)]: reserved };
    if (reserved.idempotency_storage_key) entries[reserved.idempotency_storage_key] = reserved;
    try { await this.storage.put(entries); }
    catch { throw unavailable(reserved); }
    return reserved;
  }

  completedEntries(reservation, record) {
    if (!reservation) return {};
    // The workflow can enrich model context with a server-owned funding snapshot.
    // Preserve the original caller fingerprint here, independently of that context.
    if (record.task_id !== reservation.task_id || record.request_id !== reservation.request_id || record.session_id !== reservation.session_id) throw unavailable(reservation);
    const completed = { ...reservation, state: "COMPLETED", completed_at: new Date().toISOString(),
      run_id: record.run_id, audit_id: record.audit.audit_id };
    const entries = { [taskKey(reservation.task_id)]: completed };
    if (reservation.idempotency_storage_key) entries[reservation.idempotency_storage_key] = completed;
    return entries;
  }
}

module.exports = { ReviewReservations, unavailable };
