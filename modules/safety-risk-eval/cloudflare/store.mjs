import { createHash, randomUUID } from "node:crypto";

export const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const failure = (code, message, status = 409) => Object.assign(new Error(message), { code, status });

// A single SQLite Durable Object owns request state and the append-only journal.
// Successful writes remain provisional until storage.sync() precedes external I/O.
export class RiskCloudStore {
  constructor(storage) {
    this.sql = storage.sql;
    this.sql.exec("CREATE TABLE IF NOT EXISTS risk_state (id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS risk_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT NOT NULL)");
    const row = [...this.sql.exec("SELECT body FROM risk_state WHERE id=1")][0];
    this.data = row ? JSON.parse(row.body) : { requests: {} };
    this.events = [...this.sql.exec("SELECT body FROM risk_events ORDER BY seq")].map(value => JSON.parse(value.body));
    if (!this.data || typeof this.data.requests !== "object" || Array.isArray(this.data.requests)) throw failure("STORE_STATE_INVALID", "存储状态无效，服务停止。", 503);
    let previous = "GENESIS";
    for (const event of this.events) {
      const { event_hash, ...body } = event;
      if (body.previous_hash !== previous || hash(body) !== event_hash) throw failure("AUDIT_CHAIN_INVALID", "审计链校验失败，服务保持阻断。", 503);
      previous = event_hash;
    }
    let interrupted = false;
    for (const record of Object.values(this.data.requests)) {
      if (record.status === "RUNNING") {
        record.status = "UNKNOWN";
        record.error_code = "INTERRUPTED_REQUEST_REQUIRES_RECONCILIATION";
        interrupted = true;
      }
    }
    if (!row || interrupted) this.save(this.data);
  }
  save(data) {
    this.sql.exec("INSERT INTO risk_state (id, body) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET body=excluded.body", JSON.stringify(data));
    this.data = data;
  }
  update(id, patch) {
    const copy = structuredClone(this.data);
    copy.requests[id] = { ...copy.requests[id], ...structuredClone(patch) };
    this.save(copy);
    return structuredClone(copy.requests[id]);
  }
  begin(id, fingerprint) {
    const record = this.data.requests[id];
    if (record) {
      if (record.fingerprint !== fingerprint) throw failure("IDEMPOTENCY_CONTENT_CONFLICT", "同一请求编号不能对应不同资料。");
      if (record.status === "COMPLETE" && record.response) return { replay: true, response: structuredClone(record.response) };
      throw failure("REQUEST_RECONCILIATION_REQUIRED", "原请求正在处理或结果未知；核查前不重复请求。");
    }
    if (Object.keys(this.data.requests).length >= 1000) throw failure("VALIDATION_STORAGE_LIMIT", "联调记录已满，请先归档核查。", 429);
    this.update(id, { fingerprint, status: "RUNNING", created_at: new Date().toISOString() });
    return { replay: false };
  }
  audit(id, type, value) {
    if (this.events.length >= 20000) throw failure("VALIDATION_AUDIT_LIMIT", "联调审计已满，后续动作暂停。", 503);
    const body = { ...structuredClone(value), event_id: `conversation-audit-${randomUUID()}`, request_key: id,
      occurred_at: new Date().toISOString(), event_type: type, previous_hash: this.events.at(-1)?.event_hash || "GENESIS" };
    const event = { ...body, event_hash: hash(body) };
    this.sql.exec("INSERT INTO risk_events (body) VALUES (?)", JSON.stringify(event));
    this.events.push(event);
    return structuredClone(event);
  }
}
