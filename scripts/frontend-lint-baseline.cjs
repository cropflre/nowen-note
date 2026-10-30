const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");

function fingerprint(file, message, sourceLine) {
  return createHash("sha256").update(JSON.stringify([
    file.replaceAll("\\", "/"), message.ruleId, message.message, sourceLine.trim(),
  ])).digest("hex");
}

function compare(results, root, baseline, readSource = (file) => fs.readFileSync(file, "utf8")) {
  const remaining = new Map(Object.entries(baseline.errors));
  const added = [];
  let existing = 0;
  for (const result of results) {
    const file = path.relative(root, result.filePath).replaceAll("\\", "/");
    const lines = readSource(result.filePath).split(/\r?\n/);
    for (const message of result.messages.filter((entry) => entry.severity === 2)) {
      const key = fingerprint(file, message, lines[(message.line || 1) - 1] || "");
      const count = remaining.get(key) || 0;
      if (!message.fatal && count > 0) {
        remaining.set(key, count - 1);
        existing += 1;
      } else {
        added.push({ file, ...message });
      }
    }
  }
  return { existing, added };
}

async function main() {
  const { ESLint } = require("../frontend/node_modules/eslint");
  const root = path.resolve(__dirname, "../frontend");
  const baseline = JSON.parse(fs.readFileSync(path.join(root, "eslint-baseline.json"), "utf8"));
  const results = await new ESLint({ cwd: root }).lintFiles(["."]);
  const report = compare(results, root, baseline);
  if (process.argv.includes("--emit-delta")) {
    // Diagnostic mode for a controlled baseline refresh. New errors remain failures.
    // Only exact fingerprints with their occurrence counts can enter a reviewed baseline.
    const current = new Map();
    for (const result of results) {
      const file = path.relative(root, result.filePath).replaceAll("\\", "/");
      const lines = fs.readFileSync(result.filePath, "utf8").split(/\r?\n/);
      for (const message of result.messages.filter((entry) => entry.severity === 2 && !entry.fatal)) {
        const key = fingerprint(file, message, lines[(message.line || 1) - 1] || "");
        current.set(key, (current.get(key) || 0) + 1);
      }
    }
    const add = {};
    const remove = {};
    for (const [key, count] of current) {
      if (count > (baseline.errors[key] || 0)) add[key] = count - (baseline.errors[key] || 0);
    }
    for (const [key, count] of Object.entries(baseline.errors)) {
      if (count > (current.get(key) || 0)) remove[key] = count - (current.get(key) || 0);
    }
    console.log("LINT_BASELINE_DELTA " + JSON.stringify({ add, remove }));
  }
  for (const message of report.added) {
    console.error(`${message.file}:${message.line || 1}:${message.column || 1} ${message.ruleId || "parse"} ${message.message}`);
  }
  console.log(`Lint baseline ${baseline.baseCommit}: ${report.existing} historical errors, ${report.added.length} new errors`);
  process.exitCode = report.added.length ? 1 : 0;
}

module.exports = { fingerprint, compare };
if (require.main === module) main().catch((error) => { console.error(error); process.exitCode = 1; });
