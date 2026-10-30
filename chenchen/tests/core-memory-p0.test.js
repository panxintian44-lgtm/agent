"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { MemoryStore } = require("../core/memory");
const { Harness } = require("../core/harness");

function memoryRecord(value = "保留生活备用金") {
  return { type: "decision", key: "protected-purpose", value: { text: value }, consent: true };
}

function tempFile() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "finance-lab-memory-p0-"));
  return { directory, filePath: path.join(directory, "memory.json") };
}

test("P0: unauthorized Memory writes nothing", () => {
  const { directory, filePath } = tempFile();
  try {
    const store = new MemoryStore({ filePath });
    assert.throws(() => store.save("session-no-consent", { type: "preference", value: { x: 1 } }), error => error.code === "MEMORY_CONSENT_REQUIRED");
    assert.deepEqual(store.list("session-no-consent"), []);
    assert.equal(fs.existsSync(filePath), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("P0: owner and session scopes cannot cross-read or cross-write", () => {
  const store = new MemoryStore();
  store.registerSession("session-a", { owner_id: "user-a" });
  store.registerSession("session-b", { owner_id: "user-b" });
  store.save("session-a", memoryRecord(), { owner_id: "user-a" });
  assert.equal(store.list("session-a", { owner_id: "user-a" }).length, 1);
  assert.throws(() => store.list("session-a", { owner_id: "user-b" }), error => error.code === "MEMORY_OWNER_MISMATCH");
  assert.throws(() => store.save("session-a", memoryRecord("串到另一个用户"), { owner_id: "user-b" }), error => error.code === "MEMORY_OWNER_MISMATCH");
  assert.deepEqual(store.list("session-b", { owner_id: "user-b" }), []);
});

test("P0: revocation is permanent for the session and survives restart", () => {
  const { directory, filePath } = tempFile();
  try {
    const first = new MemoryStore({ filePath });
    first.registerSession("session-revoked", { owner_id: "user-a" });
    first.save("session-revoked", memoryRecord(), { owner_id: "user-a" });
    const revocation = first.revoke("session-revoked", { owner_id: "user-a", reason: "用户撤回同意" });
    assert.equal(revocation.revoked, true);
    assert.deepEqual(first.list("session-revoked", { owner_id: "user-a" }), []);
    assert.throws(() => first.save("session-revoked", memoryRecord("撤回后不应继续使用"), { owner_id: "user-a" }), error => error.code === "MEMORY_REVOKED");

    const restarted = new MemoryStore({ filePath });
    assert.deepEqual(restarted.list("session-revoked", { owner_id: "user-a" }), []);
    assert.throws(() => restarted.registerSession("session-revoked", { owner_id: "user-a" }), error => error.code === "MEMORY_REVOKED");
    assert.throws(() => restarted.save("session-revoked", memoryRecord(), { owner_id: "user-a" }), error => error.code === "MEMORY_REVOKED");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("P0: consented Memory is readable after restart and remains task-bound", () => {
  const { directory, filePath } = tempFile();
  try {
    const store = new MemoryStore({ filePath });
    const harness = new Harness({ memory: store, owner_id: "user-a" });
    const session = harness.createSession({ owner_id: "user-a" });
    const entry = harness.saveMemory(session.task_state.task_id, memoryRecord("房租优先于新增投资"));
    assert.equal(entry.owner_id, "user-a");
    assert.equal(harness.listMemory(session.task_state.session_id, "user-a").at(0).memory_id, entry.memory_id);
    assert.throws(() => harness.listMemory(session.task_state.session_id, "user-b"), error => error.code === "MEMORY_OWNER_MISMATCH");

    const restarted = new MemoryStore({ filePath });
    assert.equal(restarted.list(session.task_state.session_id, { owner_id: "user-a" }).at(0).memory_id, entry.memory_id);
    assert.throws(() => restarted.save(session.task_state.session_id, memoryRecord("跨任务写入"), { owner_id: "user-b" }), error => error.code === "MEMORY_OWNER_MISMATCH");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
