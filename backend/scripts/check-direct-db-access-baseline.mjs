#!/usr/bin/env node

import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const baselinePath = path.join(__dirname, "direct-db-access-baseline.json");
const deferredExceptionsPath = path.join(
  __dirname,
  "direct-db-access-deferred-exceptions.json",
);
const reportPath = process.argv[2];

if (!reportPath) {
  console.error("Usage: node check-direct-db-access-baseline.mjs <report.json>");
  process.exit(2);
}

const [baseline, deferred, report] = await Promise.all([
  fs.readFile(baselinePath, "utf8").then(JSON.parse),
  fs.readFile(deferredExceptionsPath, "utf8").then(JSON.parse),
  fs.readFile(path.resolve(reportPath), "utf8").then(JSON.parse),
]);

const violations = [];
const currentFiles = new Map(report.files.map((entry) => [entry.file, entry]));

for (const [file, exception] of Object.entries(deferred.files || {})) {
  if (!/^#\d+$/.test(exception.owner || "")) {
    violations.push(`${file}: deferred exception must name an owning issue`);
  }
  if (!exception.reason || !String(exception.reason).trim()) {
    violations.push(`${file}: deferred exception must explain why it is temporarily allowed`);
  }
  if (!exception.counts || typeof exception.counts !== "object") {
    violations.push(`${file}: deferred exception must provide exact per-kind counts`);
    continue;
  }
  for (const [kind, count] of Object.entries(exception.counts)) {
    if (!Number.isInteger(count) || count < 0) {
      violations.push(`${file}: invalid deferred count for ${kind}`);
    }
  }
}

for (const entry of report.files) {
  const baselineKinds = baseline.files[entry.file] || {};
  const exception = deferred.files?.[entry.file];
  const deferredKinds = exception?.counts || {};

  if (!baseline.files[entry.file] && !exception) {
    violations.push(`${entry.file}: new direct database access file`);
    continue;
  }

  for (const [kind, count] of Object.entries(entry.counts)) {
    const allowed = Math.max(baselineKinds[kind] ?? 0, deferredKinds[kind] ?? 0);
    if (count > allowed) {
      violations.push(
        `${entry.file}: ${kind} increased from ${allowed} to ${count}` +
        (exception?.owner ? ` (owned by ${exception.owner})` : ""),
      );
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

for (const [file, exception] of Object.entries(deferred.files || {})) {
  const current = currentFiles.get(file);
  if (!current) continue;
  for (const kind of Object.keys(exception.counts || {})) {
    const count = current.counts[kind] ?? 0;
    if (count < 0) violations.push(`${file}: invalid negative count for ${kind}`);
  }
}

if (violations.length > 0) {
  console.error("Direct database access baseline check failed:\n");
  for (const violation of violations) console.error(`- ${violation}`);
  console.error(
    "\nMigrate the access, or deliberately register a temporary exception with its owning issue.",
  );
  process.exit(1);
}

const baselineOccurrences = Object.values(baseline.files)
  .flatMap((entry) => Object.values(entry))
  .reduce((sum, count) => sum + count, 0);
const reducedBy = baselineOccurrences - report.summary.occurrences;
console.log(
  `Direct database access baseline passed: ${report.summary.files} file(s), ` +
  `${report.summary.occurrences} occurrence(s), net change ${reducedBy <= 0 ? "+" : "-"}${Math.abs(reducedBy)} from the reviewed #248 baseline.`,
);
