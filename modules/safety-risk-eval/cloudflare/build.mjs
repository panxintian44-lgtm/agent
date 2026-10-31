import { createRequire } from "node:module";
import { readFile, mkdir, writeFile, unlink, rename } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { sourceDigest, verifyBuildSnapshot } from "./build-snapshot.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const adapters = path.resolve(here, "../interface-adapters");
const output = path.join(here, "dist");
const manifestPath = path.join(output, "source-manifest.json");
const pendingBundle = path.join(output, "risk-worker.building.mjs");
const pendingManifest = path.join(output, "source-manifest.building.json");
async function removeGeneratedFile(file) { try { await unlink(file); } catch (error) { if (error.code !== "ENOENT") throw error; } }
// No failed build may leave a stale manifest advertising a release-ready bundle.
await removeGeneratedFile(manifestPath);
const readGitSnapshot = () => ({
  head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", windowsHide: true }).trim(),
  status: execFileSync("git", ["status", "--porcelain", "--untracked-files=normal"], { cwd: root, encoding: "utf8", windowsHide: true }).trim()
});
const before = readGitSnapshot();
const sourceCommit = before.head;
const dirty = Boolean(before.status);
if (dirty && !process.argv.includes("--allow-dirty")) throw new Error("SOURCE_DIRTY: commit reviewed sources first; --allow-dirty is only for local test artifacts.");
const requireOwner = createRequire(path.join(adapters, "package.json"));
const Ajv = requireOwner("ajv/dist/2020");
const standalone = requireOwner("ajv/dist/standalone").default;
const sourceHashes = {};
function rememberSource(relative, raw) {
  const digest = sourceDigest(raw);
  if (sourceHashes[relative] && sourceHashes[relative] !== digest) throw new Error(`BUILD_SOURCE_CHANGED_WHILE_READING: ${relative}`);
  sourceHashes[relative] = digest;
}
async function readJsonSource(relative) {
  const raw = await readFile(path.join(root, relative), "utf8");
  rememberSource(relative, raw);
  return JSON.parse(raw);
}
for (const relative of ["modules/safety-risk-eval/cloudflare/build.mjs", "modules/safety-risk-eval/cloudflare/build-snapshot.mjs", "modules/safety-risk-eval/cloudflare/package.json", "modules/safety-risk-eval/cloudflare/package-lock.json", "modules/safety-risk-eval/interface-adapters/package.json", "modules/safety-risk-eval/interface-adapters/package-lock.json"]) rememberSource(relative, await readFile(path.join(root, relative)));
const schema = await readJsonSource("chenchen/contracts/risk-handoff.v1.schema.json");
const riskRuntime = await readJsonSource("modules/safety-risk-eval/unified-rating/runtime-config.v1.1.json");
const ajv = new Ajv({ strict: false, allErrors: true, code: { source: true } });
for (const name of ["agent-output.v1", "model-review.v1", "owner-bridge.v1", "funding-plan-demo.v1"]) ajv.addSchema(await readJsonSource(`chenchen/contracts/${name}.schema.json`));
ajv.addSchema(schema);
const validator = standalone(ajv, ajv.compile({ $ref: `${schema.$id}#/$defs/HandoffPackage` }));
await mkdir(output, { recursive: true });
try {
await build({ absWorkingDir: root, entryPoints: [path.join(here, "worker.mjs")], outfile: pendingBundle, bundle: true,
  format: "esm", platform: "neutral", target: "es2022", conditions: ["workerd", "worker", "browser"],
  plugins: [{ name: "risk-owner-current-candidate", setup(builder) {
    builder.onResolve({ filter: /^node:/ }, args => args.kind === "require-call" ? { path: args.path, namespace: "node-esm" } : { path: args.path, external: true });
    builder.onLoad({ filter: /.*/, namespace: "node-esm" }, args => ({ contents: `export * from ${JSON.stringify(args.path)};`, loader: "js" }));
    builder.onResolve({ filter: /^generated-risk-build-info$/ }, () => ({ path: "build-info", namespace: "generated" }));
    builder.onLoad({ filter: /^build-info$/, namespace: "generated" }, () => ({ contents: `export default ${JSON.stringify({ source_commit: sourceCommit, source_dirty: dirty, policy_runtime: riskRuntime.runtime_version, risk_policy_version: riskRuntime.risk_policy_version, package_version: "1.1.0" })};`, loader: "js" }));
    builder.onResolve({ filter: /^generated-risk-handoff-validator$/ }, () => ({ path: "validator", namespace: "standalone" }));
    builder.onLoad({ filter: /.*/, namespace: "standalone" }, () => ({ contents: validator, loader: "js", resolveDir: adapters }));
    builder.onResolve({ filter: /conversation-store\.cjs$/ }, args => args.importer.endsWith("conversation-review.cjs") ? { path: path.join(here, "store.mjs") } : null);
    builder.onLoad({ filter: /\.(?:cjs|mjs|js|json)$/ }, async args => {
      if (!args.path.startsWith(root + path.sep) || args.path.includes(`${path.sep}node_modules${path.sep}`)) return;
      const raw = await readFile(args.path, "utf8");
      rememberSource(path.relative(root, args.path).replaceAll("\\", "/"), raw);
      if (path.resolve(args.path) !== path.join(adapters, "core-client.cjs")) return { contents: raw, loader: args.path.endsWith(".json") ? "json" : "js" };
      const start = raw.indexOf('const Ajv = require("ajv/dist/2020");');
      const end = raw.indexOf("function validateBaseUrl");
      if (start < 0 || end < start) throw new Error("CORE_CLIENT_PRELUDE_CHANGED: review the build transformation before continuing.");
      return { contents: raw.slice(0, start) + 'const validateHandoff = require("generated-risk-handoff-validator");\nconst { ConversationError } = require("./conversation-input.cjs");\nconst { extractCoreBinding } = require("./risk-callback.cjs");\n' + raw.slice(end), loader: "js", resolveDir: adapters };
    });
  } }] });
const manifest = { manifest_version: "risk-cloud-build.v1", source_commit: sourceCommit, source_dirty: dirty,
  release_eligible: !dirty, source_files_sha256: Object.fromEntries(Object.entries(sourceHashes).sort(([left], [right]) => left.localeCompare(right))),
  toolchain: { node: process.version, esbuild: JSON.parse(await readFile(path.join(here, "node_modules/esbuild/package.json"), "utf8")).version, ajv: requireOwner("ajv/package.json").version },
  bundle_sha256: createHash("sha256").update(await readFile(pendingBundle)).digest("hex"),
  transformations: ["Official current Handoff schema compiled with Ajv standalone at build time", "Durable Object SQLite store replaces local filesystem store", "Node built-in requires converted to native ESM imports"],
  supported_direction: "Risk conversation -> Core review -> REVIEW_ONLY signed Risk callback",
  core_owner_bridge_receiver: false, simulation_callback_http: false, deployed: false, formal_joint_acceptance: false };
await verifyBuildSnapshot({ before, readGitSnapshot, sourceHashes, readSource: relative => readFile(path.join(root, relative)),
  readCommitted: (commit, relative) => execFileSync("git", ["show", `${commit}:${relative}`], { cwd: root, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }) });
await writeFile(pendingManifest, JSON.stringify(manifest, null, 2) + "\n");
await rename(pendingBundle, path.join(output, "risk-worker.mjs"));
await rename(pendingManifest, manifestPath);
console.log(JSON.stringify({ output, source_commit: sourceCommit, source_dirty: dirty, source_files: Object.keys(sourceHashes).length, bundle_sha256: manifest.bundle_sha256, deployed: false }));
} catch (error) {
  await removeGeneratedFile(manifestPath);
  await removeGeneratedFile(pendingManifest);
  await removeGeneratedFile(pendingBundle);
  throw error;
}
