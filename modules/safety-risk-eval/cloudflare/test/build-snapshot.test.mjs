import test from "node:test";
import assert from "node:assert/strict";
import { sourceDigest, verifyBuildSnapshot } from "../build-snapshot.mjs";

const HEAD = "a".repeat(40);
const source = Buffer.from("const reviewed = true;\r\n");
function fixture(overrides = {}) {
  return { before: { head: HEAD, status: "" }, readGitSnapshot: () => ({ head: HEAD, status: "" }),
    sourceHashes: { "source.mjs": sourceDigest(source) }, readSource: () => source,
    readCommitted: () => Buffer.from("const reviewed = true;\n"), ...overrides };
}
test("build snapshot verifies consumed bytes against a clean immutable commit", async () => {
  const result = await verifyBuildSnapshot(fixture());
  assert.equal(result.source_dirty, false);
  assert.equal(result.files, 1);
});
test("HEAD changes during build reject the release snapshot", async () => {
  await assert.rejects(verifyBuildSnapshot(fixture({ readGitSnapshot: () => ({ head: "b".repeat(40), status: "" }) })), /BUILD_HEAD_CHANGED/);
});
test("a changed working tree rejects the release snapshot", async () => {
  await assert.rejects(verifyBuildSnapshot(fixture({ readGitSnapshot: () => ({ head: HEAD, status: "M source.mjs" }) })), /BUILD_WORKTREE_CHANGED/);
});
test("modified input is rejected even when its Git dirty status stays the same", async () => {
  await assert.rejects(verifyBuildSnapshot(fixture({ before: { head: HEAD, status: "M source.mjs" },
    readGitSnapshot: () => ({ head: HEAD, status: "M source.mjs" }), readSource: () => Buffer.from("changed") })), /BUILD_SOURCE_CHANGED/);
});
test("a clean label does not override mismatching committed source", async () => {
  await assert.rejects(verifyBuildSnapshot(fixture({ readCommitted: () => Buffer.from("different committed code") })), /BUILD_SOURCE_NOT_COMMITTED/);
});
test("dirty local snapshots remain dirty and do not claim committed source equality", async () => {
  const result = await verifyBuildSnapshot(fixture({ before: { head: HEAD, status: "M source.mjs" },
    readGitSnapshot: () => ({ head: HEAD, status: "M source.mjs" }), readCommitted: () => { throw new Error("must not use release checks for a dirty local snapshot"); } }));
  assert.equal(result.source_dirty, true);
});
test("the terminal Git check also rejects changes after hashing source inputs", async () => {
  let checks = 0;
  await assert.rejects(verifyBuildSnapshot(fixture({ readGitSnapshot: () => ({ head: ++checks === 1 ? HEAD : "b".repeat(40), status: "" }) })), /BUILD_HEAD_CHANGED/);
});
