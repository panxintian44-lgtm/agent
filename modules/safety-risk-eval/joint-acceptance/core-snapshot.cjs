"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");

const CORE_COMMIT = "9e6bed133c36f7fa42fc15f4dc7a8791049b0841";
const REPO_ROOT = path.resolve(__dirname, "../../..");
const OVERLAY = "chenchen/integrations/review-workflow.js";
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

function command(executable, args, cwd) {
  const result = spawnSync(executable, args, { cwd, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(`${executable} failed. Fetch the pinned Core commit and ensure Git and tar are installed.`);
  return result.stdout.trim();
}

function prepareCoreSnapshot() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "risk-joint-core-"));
  const dispose = () => {
    const resolved = path.resolve(directory);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith("risk-joint-core-")) throw new Error("Unsafe temporary cleanup target.");
    fs.rmSync(resolved, { recursive: true, force: true });
  };
  try {
    const tree = command("git", ["rev-parse", `${CORE_COMMIT}:chenchen`], REPO_ROOT);
    const archive = path.join(directory, "core.tar");
    const sources = ["core", "tools", "data", "contracts", "integrations", "deployment"].map(directory => `chenchen/${directory}`);
    command("git", ["archive", "--format=tar", `--output=${archive}`, CORE_COMMIT, ...sources], REPO_ROOT);
    command("tar", ["-xf", archive, "-C", directory], REPO_ROOT);
    fs.unlinkSync(archive);
    const destination = path.join(directory, OVERLAY);
    const originalHash = sha256(fs.readFileSync(destination));
    const candidate = fs.readFileSync(path.join(REPO_ROOT, OVERLAY));
    fs.writeFileSync(destination, candidate);
    return { directory, dispose, manifest: {
      core_commit: CORE_COMMIT, core_tree: tree,
      candidate_overlays: [{ path: OVERLAY, base_sha256: originalHash, candidate_sha256: sha256(candidate), changed: originalHash !== sha256(candidate) }],
      risk_sources: Object.fromEntries(["daily-engine.cjs", ...["money", "conversation-input", "conversation-risk", "conversation-store", "conversation-review", "core-client", "risk-callback", "risk-callback-sender"].map(name => `interface-adapters/${name}.cjs`)]
        .map(file => [file, sha256(fs.readFileSync(path.join(REPO_ROOT, "modules/safety-risk-eval", file)))]))
    } };
  } catch (error) { dispose(); throw error; }
}

module.exports = { prepareCoreSnapshot, CORE_COMMIT, REPO_ROOT, sha256 };
