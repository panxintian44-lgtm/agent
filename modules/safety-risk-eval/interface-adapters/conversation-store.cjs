"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { ConversationError } = require("./conversation-input.cjs");
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");

// One writer, durable intent journal, and atomic local state. Not a shared bank ledger.
class ConversationStore {
  constructor(directory) {
    this.directory = path.resolve(directory); fs.mkdirSync(this.directory, { recursive: true });
    this.lock = path.join(this.directory, "writer.lock"); this.lockFd = fs.openSync(this.lock, "wx");
    this.stateFile = path.join(this.directory, "conversation-state.json"); this.auditFile = path.join(this.directory, "conversation-audit.jsonl");
    try {
      this.data = fs.existsSync(this.stateFile) ? JSON.parse(fs.readFileSync(this.stateFile, "utf8")) : { requests: {} };
      this.events = fs.existsSync(this.auditFile) ? fs.readFileSync(this.auditFile, "utf8").split("\n").filter(Boolean).map(JSON.parse) : [];
      let previous = "GENESIS";
      for (const event of this.events) { const { event_hash, ...body } = event; if (body.previous_hash !== previous || hash(body) !== event_hash) throw new Error("AUDIT_CHAIN_INVALID"); previous = event_hash; }
      for (const record of Object.values(this.data.requests)) if (record.status === "RUNNING") { record.status = "UNKNOWN"; record.error_code = "INTERRUPTED_REQUEST_REQUIRES_RECONCILIATION"; }
      this.save(this.data);
    } catch (error) { this.close(); throw error; }
  }
  save(data) {
    const temp = `${this.stateFile}.${randomUUID()}.tmp`, fd = fs.openSync(temp, "wx");
    try { fs.writeFileSync(fd, JSON.stringify(data)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temp, this.stateFile); this.data = data;
  }
  update(id, patch) { const copy = structuredClone(this.data); copy.requests[id] = { ...copy.requests[id], ...structuredClone(patch) }; this.save(copy); return structuredClone(copy.requests[id]); }
  begin(id, fingerprint) {
    const old = this.data.requests[id];
    if (old) {
      if (old.fingerprint !== fingerprint) throw new ConversationError("IDEMPOTENCY_CONTENT_CONFLICT", "同一请求编号不能对应不同的资金安排。", 409);
      if (old.status === "COMPLETE" && old.response) return { replay: true, response: structuredClone(old.response) };
      throw new ConversationError("REQUEST_RECONCILIATION_REQUIRED", "原请求仍在处理或结果待核查；不会重复调用模型或发送回调。", 409);
    }
    this.update(id, { fingerprint, status: "RUNNING", created_at: new Date().toISOString() }); return { replay: false };
  }
  audit(id, type, value) {
    const body = { event_id: `conversation-audit-${randomUUID()}`, request_key: id, occurred_at: new Date().toISOString(), event_type: type, ...structuredClone(value), previous_hash: this.events.at(-1)?.event_hash || "GENESIS" };
    const event = { ...body, event_hash: hash(body) }, fd = fs.openSync(this.auditFile, "a");
    try { fs.writeFileSync(fd, JSON.stringify(event) + "\n"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    this.events.push(event); return structuredClone(event);
  }
  close() { if (this.lockFd !== undefined) { fs.closeSync(this.lockFd); this.lockFd = undefined; fs.unlinkSync(this.lock); } }
}
module.exports = { ConversationStore, hash };
