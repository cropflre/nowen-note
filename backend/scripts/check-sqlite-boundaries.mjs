#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(__dirname, "..");
const baselinePath = path.join(__dirname, "sqlite-boundary-baseline.json");

const scanRoots = [
  "src/routes",
  "src/services",
  "src/queries",
  "src/lib",
  "src/middleware",
  "src/runtime",
];

const scanFiles = [
  "src/index.ts",
  "src/index.hardened.ts",
  "src/index.postgres-runtime.ts",
];

const sourceExtensions = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs"]);

const rules = [
  {
    id: "db-schema-import",
    pattern: /from\s+["'][^"']*\/db\/schema(?:\.(?:js|ts))?["']/g,
  },
  {
    id: "better-sqlite3-import",
    pattern: /from\s+["']better-sqlite3["']/g,
  },
  {
    id: "getDb-call",
    pattern: /\bgetDb\s*\(/g,
  },
  {
    id: "db-prepare",
    pattern: /\b(?:db|database)\s*\.\s*prepare\s*\(/g,
  },
  {
    id: "db-exec",
    pattern: /\b(?:db|database)\s*\.\s*exec\s*\(/g,
  },
  {
    id: "db-transaction",
    pattern: /\b(?:db|database)\s*\.\s*transaction\s*\(/g,
  },
  {
    id: "pragma",
    pattern: /\bPRAGMA\b/gi,
  },
  {
    id: "sqlite-master",
    pattern: /\bsqlite_master\b/gi,
  },
  {
    id: "sqlite-vec",
    pattern: /\bsqlite-vec\b/g,
  },
  {
    id: "db-path-env",
    pattern: /\bDB_PATH\b/g,
  },
  {
    id: "sqlite-sidecar",
    pattern: /(?:-wal|-shm|\.db\b)/g,
  },
];

async function walk(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walk(absolute));
      continue;
    }
    if (entry.isFile() && sourceExtensions.has(path.extname(entry.name))) {
      files.push(absolute);
    }
  }

  return files;
}

function relativeToBackend(absolutePath) {
  return path.relative(backendRoot, absolutePath).split(path.sep).join("/");
}

function countMatches(content, rule) {
  const pattern = new RegExp(rule.pattern.source, rule.pattern.flags);
  let count = 0;
  while (pattern.exec(content)) {
    count += 1;
    if (pattern.lastIndex === 0) pattern.lastIndex += 1;
  }
  return count;
}

function parseReportPath() {
  const prefix = "--report=";
  const arg = process.argv.find((value) => value.startsWith(prefix));
  return arg ? path.resolve(process.cwd(), arg.slice(prefix.length)) : null;
}

function validateBaselineEntry(file, entry) {
  const errors = [];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return [`${file}: baseline entry must be an object`];
  }
  if (typeof entry.category !== "string" || !entry.category.trim()) {
    errors.push(`${file}: category is required`);
  }
  if (typeof entry.owner !== "string" || !entry.owner.trim()) {
    errors.push(`${file}: owner is required`);
  }
  if (typeof entry.followUp !== "string" || !entry.followUp.trim()) {
    errors.push(`${file}: followUp issue is required`);
  }
  if (typeof entry.reason !== "string" || !entry.reason.trim()) {
    errors.push(`${file}: reason is required`);
  }
  if (!entry.maxByRule || typeof entry.maxByRule !== "object" || Array.isArray(entry.maxByRule)) {
    errors.push(`${file}: maxByRule is required`);
  }
  return errors;
}

async function main() {
  const baseline = JSON.parse(await fs.readFile(baselinePath, "utf8"));
  const candidates = [];

  for (const root of scanRoots) {
    const absolute = path.join(backendRoot, root);
    try {
      candidates.push(...await walk(absolute));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  for (const file of scanFiles) {
    const absolute = path.join(backendRoot, file);
    try {
      const stat = await fs.stat(absolute);
      if (stat.isFile()) candidates.push(absolute);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  const findings = [];
  for (const absolute of [...new Set(candidates)].sort()) {
    const content = await fs.readFile(absolute, "utf8");
    const counts = {};
    for (const rule of rules) {
      const count = countMatches(content, rule);
      if (count > 0) counts[rule.id] = count;
    }
    if (Object.keys(counts).length > 0) {
      findings.push({ file: relativeToBackend(absolute), counts });
    }
  }

  const failures = [];
  const findingMap = new Map(findings.map((finding) => [finding.file, finding]));

  for (const finding of findings) {
    const entry = baseline[finding.file];
    if (!entry) {
      failures.push(`${finding.file}: unregistered SQLite direct access ${JSON.stringify(finding.counts)}`);
      continue;
    }

    failures.push(...validateBaselineEntry(finding.file, entry));
    const maxByRule = entry.maxByRule || {};
    for (const [rule, count] of Object.entries(finding.counts)) {
      const maximum = maxByRule[rule];
      if (!Number.isInteger(maximum) || maximum < 0) {
        failures.push(`${finding.file}: missing non-negative maxByRule.${rule}`);
      } else if (count > maximum) {
        failures.push(`${finding.file}: ${rule} increased from baseline ${maximum} to ${count}`);
      }
    }
  }

  for (const [file, entry] of Object.entries(baseline)) {
    failures.push(...validateBaselineEntry(file, entry));
    if (!findingMap.has(file)) {
      failures.push(`${file}: stale baseline entry; remove it after the direct access is migrated`);
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    scannedFiles: candidates.length,
    filesWithDirectAccess: findings.length,
    findings,
    failures,
  };

  const reportPath = parseReportPath();
  if (reportPath) {
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }

  console.log(`[sqlite-boundary] scanned ${report.scannedFiles} source files`);
  console.log(`[sqlite-boundary] found direct access in ${report.filesWithDirectAccess} files`);

  if (failures.length > 0) {
    console.error(`\n[sqlite-boundary] ${failures.length} violation(s):`);
    for (const failure of failures) console.error(`  - ${failure}`);

    const missing = findings.filter((finding) => !baseline[finding.file]);
    if (missing.length > 0) {
      console.error("\nSuggested baseline entries (classify each item before committing):");
      const suggestion = Object.fromEntries(missing.map((finding) => [
        finding.file,
        {
          category: "ordinary-crud",
          owner: "PG-DIRECT-DB-AUDIT-01",
          followUp: "#248",
          reason: "TODO: classify and explain why this direct SQLite access remains temporarily",
          maxByRule: finding.counts,
        },
      ]));
      console.error(JSON.stringify(suggestion, null, 2));
    }

    process.exit(1);
  }

  console.log("[sqlite-boundary] baseline is valid; no unregistered or increased direct SQLite access detected");
}

main().catch((error) => {
  console.error("[sqlite-boundary] scan failed", error);
  process.exit(1);
});
