"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function memoryError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function contextOwner(context) {
  if (typeof context === "string") return context.trim() || null;
  const owner = context?.owner_id;
  return typeof owner === "string" && owner.trim() ? owner.trim() : null;
}

/**
 * Consent-bound Memory used by the Core harness.
 *
 * The default remains an in-process store for the existing demo. A filePath
 * can be supplied by a server adapter when restart recovery is required. The
 * policy stays deliberately narrow: only user-confirmed preferences and
 * decisions are accepted, and a revoked session is permanently read/write
 * blocked until the store is explicitly reset by an operator.
 */
class MemoryStore {
  constructor({ filePath = null, clock = () => new Date() } = {}) {
    this.filePath = filePath ? path.resolve(filePath) : null;
    this.clock = clock;
    this.sessions = new Map();
    this.sessionOwners = new Map();
    this.revocations = new Map();
    this.load();
  }

  now() {
    const value = this.clock();
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) throw memoryError("MEMORY_CLOCK_INVALID", "memory clock returned an invalid date");
    return date.toISOString();
  }

  load() {
    if (!this.filePath || !fs.existsSync(this.filePath)) return;
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
    } catch (error) {
      throw memoryError("MEMORY_STORAGE_INVALID", `memory storage cannot be read: ${error.message}`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw memoryError("MEMORY_STORAGE_INVALID", "memory storage must be an object");
    }
    for (const [sessionId, entries] of Object.entries(parsed.sessions || {})) {
      if (!Array.isArray(entries)) throw memoryError("MEMORY_STORAGE_INVALID", "memory session entries must be arrays");
      this.sessions.set(sessionId, entries);
    }
    for (const [sessionId, ownerId] of Object.entries(parsed.session_owners || {})) {
      if (typeof ownerId === "string" && ownerId) this.sessionOwners.set(sessionId, ownerId);
    }
    for (const [sessionId, revocation] of Object.entries(parsed.revocations || {})) {
      if (revocation && typeof revocation === "object") this.revocations.set(sessionId, revocation);
    }
  }

  persist() {
    if (!this.filePath) return;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const payload = JSON.stringify({
      version: "memory-store.v1",
      sessions: Object.fromEntries(this.sessions),
      session_owners: Object.fromEntries(this.sessionOwners),
      revocations: Object.fromEntries(this.revocations)
    }, null, 2) + "\n";
    fs.writeFileSync(this.filePath, payload, { encoding: "utf8", mode: 0o600 });
  }

  assertSessionId(sessionId) {
    if (typeof sessionId !== "string" || !sessionId.trim()) throw memoryError("MEMORY_SESSION_REQUIRED", "session_id is required");
    return sessionId.trim();
  }

  assertOwner(sessionId, ownerId) {
    const boundOwner = this.sessionOwners.get(sessionId);
    if (ownerId && boundOwner && ownerId !== boundOwner) {
      throw memoryError("MEMORY_OWNER_MISMATCH", "memory session belongs to a different owner");
    }
    return boundOwner || null;
  }

  requireBoundOwner(sessionId, ownerId) {
    const boundOwner = this.assertOwner(sessionId, ownerId);
    if (boundOwner && !ownerId) throw memoryError("MEMORY_OWNER_REQUIRED", "owner_id is required for a bound memory session");
    return boundOwner;
  }

  assertNotRevoked(sessionId) {
    if (this.revocations.has(sessionId)) {
      throw memoryError("MEMORY_REVOKED", "memory session was revoked and cannot be used");
    }
  }

  registerSession(sessionId, context = {}) {
    const normalizedId = this.assertSessionId(sessionId);
    const ownerId = contextOwner(context);
    this.assertNotRevoked(normalizedId);
    const boundOwner = this.assertOwner(normalizedId, ownerId);
    if (!this.sessions.has(normalizedId)) this.sessions.set(normalizedId, []);
    if (ownerId && !boundOwner) this.sessionOwners.set(normalizedId, ownerId);
    this.persist();
    return { session_id: normalizedId, owner_id: this.sessionOwners.get(normalizedId) || null };
  }

  ensureSession(sessionId, context = {}) {
    const normalizedId = this.assertSessionId(sessionId);
    const ownerId = contextOwner(context);
    this.assertNotRevoked(normalizedId);
    this.assertOwner(normalizedId, ownerId);
    if (!this.sessions.has(normalizedId)) this.sessions.set(normalizedId, []);
    return this.sessions.get(normalizedId);
  }

  save(sessionId, record, context = {}) {
    // Validate consent before creating a session, binding an owner, or writing
    // any file. This is the no-write guarantee for unauthorized requests.
    if (!record || !["preference", "decision"].includes(record.type)) {
      throw memoryError("MEMORY_TYPE_INVALID", "memory type must be preference or decision");
    }
    if (record.consent !== true) throw memoryError("MEMORY_CONSENT_REQUIRED", "explicit consent is required before memory is saved");
    const normalizedId = this.assertSessionId(sessionId);
    const ownerId = contextOwner(context);
    this.assertNotRevoked(normalizedId);
    const boundOwner = this.requireBoundOwner(normalizedId, ownerId);
    const entries = this.ensureSession(normalizedId, context);
    if (ownerId && !boundOwner) this.sessionOwners.set(normalizedId, ownerId);
    const entry = {
      memory_id: `memory-${crypto.randomUUID()}`,
      owner_id: ownerId || boundOwner || null,
      session_id: normalizedId,
      type: record.type,
      key: record.key || record.type,
      value: clone(record.value || {}),
      source: "user_confirmed",
      consent: true,
      created_at: this.now()
    };
    entries.push(entry);
    this.persist();
    return clone(entry);
  }

  list(sessionId, context = {}) {
    if (typeof sessionId !== "string" || !sessionId.trim()) return [];
    const normalizedId = sessionId.trim();
    const ownerId = contextOwner(context);
    this.requireBoundOwner(normalizedId, ownerId);
    // Returning an empty set after revocation avoids leaking the old content;
    // save/registration still fail closed with MEMORY_REVOKED.
    if (this.revocations.has(normalizedId)) return [];
    return clone(this.sessions.get(normalizedId) || []);
  }

  revoke(sessionId, context = {}) {
    const normalizedId = this.assertSessionId(sessionId);
    const ownerId = contextOwner(context);
    this.requireBoundOwner(normalizedId, ownerId);
    const revocation = {
      session_id: normalizedId,
      owner_id: ownerId || this.sessionOwners.get(normalizedId) || null,
      revoked_at: this.now(),
      reason: typeof context?.reason === "string" && context.reason.trim() ? context.reason.trim() : "user_requested"
    };
    this.revocations.set(normalizedId, revocation);
    this.persist();
    return { ...clone(revocation), revoked: true };
  }

  clear(sessionId, context = {}) {
    return { ...this.revoke(sessionId, { ...context, reason: context.reason || "explicit_clear" }), cleared: true };
  }

  reset() {
    this.sessions.clear();
    this.sessionOwners.clear();
    this.revocations.clear();
    this.persist();
  }
}

module.exports = { MemoryStore };
