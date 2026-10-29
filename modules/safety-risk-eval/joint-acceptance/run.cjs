"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { prepareCoreSnapshot } = require("./core-snapshot.cjs");
const { runLocalAcceptance } = require("./harness.cjs");

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 0 && !(args.length === 2 && args[0] === "--out")) throw new Error("Usage: node run.cjs [--out report.json]");
  const snapshot = prepareCoreSnapshot();
  let report;
  try { report = await runLocalAcceptance(snapshot); } finally { snapshot.dispose(); }
  if (args[1]) fs.writeFileSync(path.resolve(args[1]), JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
  console.log(JSON.stringify({ mode: report.mode, passed: report.passed, failed: report.failed, real_model_calls: 0,
    joint_acceptance: false, production_connected: false, failures: report.failures }, null, 2));
  if (report.failed) process.exitCode = 1;
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
