#!/usr/bin/env node

import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const baselinePath = path.join(__dirname, "direct-db-access-baseline.json");
const reportPath = process.argv[2];

if (!reportPath) {
  console.error("Usage: node check-direct-db-access-baseline.mjs <report.json>");
  process.exit(2);
}

const [baseline, report] = await Promise.all([
  fs.readFile(baselinePath, "utf8").then(JSON.parse),
  fs.readFile(path.resolve(reportPath), "utf8").then(JSON.parse),
]);

const violations = [];
const currentFiles = new Map(report.files.map((entry) => [entry.file, entry]));

for (const entry of report.files) {
  const allowedKinds = baseline.files[entry.file];
  if (!allowedKinds) {
    violations.push(`${entry.file}: new direct database access file`);
    continue;
  }

  for (const [kind, count] of Object.entries(entry.counts)) {
    const allowed = allowedKinds[kind] ?? 0;
    if (count > allowed) {
      violations.push(`${entry.file}: ${kind} increased from ${allowed} to ${count}`);
    }
  }
}

for (const [file, allowedKinds] of Object.entries(baseline.files)) {
  const current = currentFiles.get(file);
  if (!current) continue;
  for (const kind of Object.keys(allowedKinds)) {
    const count = current.counts[kind] ?? 0;
    if (count < 0) violations.push(`${file}: invalid negative count for ${kind}`);
  }
}

if (violations.length > 0) {
  console.error("Direct database access baseline check failed:\n");
  for (const violation of violations) console.error(`- ${violation}`);
  console.error("\nMigrate the access, or deliberately review and update the baseline in #248.");
  process.exit(1);
}

const baselineOccurrences = Object.values(baseline.files)
  .flatMap((entry) => Object.values(entry))
  .reduce((sum, count) => sum + count, 0);
const reducedBy = baselineOccurrences - report.summary.occurrences;
console.log(
  `Direct database access baseline passed: ${report.summary.files} file(s), ` +
  `${report.summary.occurrences} occurrence(s), reduced by ${reducedBy}.`,
);
