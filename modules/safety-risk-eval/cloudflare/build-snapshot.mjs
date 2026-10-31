import { createHash } from "node:crypto";

export const sourceDigest = value => createHash("sha256").update(value).digest("hex");
const normalizedDigest = value => sourceDigest(value.toString("utf8").replaceAll("\r\n", "\n"));
function assertGitSnapshot(before, current) {
  if (current.head !== before.head) throw new Error("BUILD_HEAD_CHANGED: HEAD changed during the build.");
  if (current.status !== before.status) throw new Error("BUILD_WORKTREE_CHANGED: Git status changed during the build.");
}

// Verify the bytes actually consumed, not only whether Git initially looked clean.
// A release additionally matches all consumed text to its immutable commit content.
export async function verifyBuildSnapshot({ before, readGitSnapshot, sourceHashes, readSource, readCommitted }) {
  assertGitSnapshot(before, await readGitSnapshot());
  for (const [relative, expected] of Object.entries(sourceHashes)) {
    const actual = await readSource(relative);
    if (sourceDigest(actual) !== expected) throw new Error(`BUILD_SOURCE_CHANGED: ${relative}`);
    if (!before.status && readCommitted) {
      const committed = await readCommitted(before.head, relative);
      if (normalizedDigest(actual) !== normalizedDigest(committed)) throw new Error(`BUILD_SOURCE_NOT_COMMITTED: ${relative}`);
    }
  }
  assertGitSnapshot(before, await readGitSnapshot());
  return { head: before.head, source_dirty: Boolean(before.status), files: Object.keys(sourceHashes).length };
}
