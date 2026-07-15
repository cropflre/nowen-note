#!/usr/bin/env node

import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendDir = path.resolve(__dirname, "..");
const srcDir = path.join(backendDir, "src");
const baselinePath = path.join(__dirname, "direct-db-access-baseline.json");

const args = new Set(process.argv.slice(2));
const valueAfter = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const reportJsonPath = valueAfter("--report-json");
const reportMdPath = valueAfter("--report-md");
const writeBaseline = args.has("--write-baseline");
const check = args.has("--check");

const targetRoots = ["routes", "services", "queries", "lib", "middleware"];

const patterns = [
  {
    kind: "getDb-call",
    regex: /\bgetDb\s*\(/g,
    description: "Direct getDb() access",
  },
  {
    kind: "better-sqlite3",
    regex: /(?:from\s*["']better-sqlite3["']|require\(\s*["']better-sqlite3["']\s*\))/g,
    description: "Direct better-sqlite3 dependency",
  },
  {
    kind: "prepare-call",
    regex: /\b[A-Za-z_$][\w$]*\.prepare\s*\(/g,
    description: "Direct prepared statement usage",
  },
  {
    kind: "transaction-call",
    regex: /\b[A-Za-z_$][\w$]*\.transaction\s*\(/g,
    description: "Direct SQLite-style transaction usage",
  },
  {
    kind: "db-exec-call",
    regex: /\b(?:db|database|sqlite|sourceDb|targetDb)\.exec\s*\(/gi,
    description: "Direct database exec usage",
  },
  {
    kind: "pragma",
    regex: /\bPRAGMA\b/gi,
    description: "SQLite PRAGMA usage",
  },
  {
    kind: "sqlite-master",
    regex: /\bsqlite_master\b/gi,
    description: "sqlite_master dependency",
  },
  {
    kind: "sqlite-vec",
    regex: /\bsqlite[-_]vec\b|\bvec0\b/gi,
    description: "sqlite-vec / vec0 dependency",
  },
  {
    kind: "sqlite-file-runtime",
    regex: /\bDB_PATH\b|(?:-wal|-shm)\b/g,
    description: "SQLite file/WAL runtime dependency",
  },
];

const explicitCategories = [
  {
    test: (file) => /(?:^|\/)(?:search\.ts|vec-store\.ts|embedding-worker\.ts)$/.test(file),
    category: "deferred-search-vector",
    followUp: "#252",
    reason: "FTS5/sqlite-vec migration is owned by PG-SEARCH-01",
  },
  {
    test: (file) => /(?:backup|restore|reclaimSpace|reliableExportJobs)/i.test(file),
    category: "deferred-backup-recovery",
    followUp: "#253",
    reason: "SQLite file backup/restore is owned by PG-BACKUP-01",
  },
  {
    test: (file) => /(?:user-migration|PackageImport|PackageExport|folder-sync)/i.test(file),
    category: "migration-or-import-export",
    followUp: "#251",
    reason: "Bulk data movement requires explicit migration/import transaction design",
  },
  {
    test: (file) => file.startsWith("routes/"),
    category: "route-to-repository",
    followUp: "#248",
    reason: "Route handlers must delegate database access to async repositories/services",
  },
  {
    test: (file) => file.startsWith("queries/"),
    category: "query-service-to-adapter",
    followUp: "#248",
    reason: "Query services must use DatabaseAdapter-backed repositories",
  },
  {
    test: (file) => file.startsWith("services/"),
    category: "service-to-repository",
    followUp: "#248",
    reason: "Services must use explicit repository or database service boundaries",
  },
  {
    test: (file) => file.startsWith("lib/"),
    category: "library-boundary-review",
    followUp: "#248",
    reason: "Library modules require an injected database boundary or registered exception",
  },
  {
    test: () => true,
    category: "business-layer-review",
    followUp: "#248",
    reason: "Direct database access requires migration or an explicit exception",
  },
];

async function listFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFiles(fullPath));
    } else if (entry.isFile() && /\.(?:ts|tsx|js|mjs|cjs)$/.test(entry.name)) {
      files.push(fullPath);
    }
  }
  return files;
}

function lineForIndex(text, index) {
  return text.slice(0, index).split("\n").length;
}

function classify(file) {
  return explicitCategories.find((entry) => entry.test(file));
}

async function scan() {
  const absoluteFiles = [];
  for (const root of targetRoots) {
    const dir = path.join(srcDir, root);
    try {
      absoluteFiles.push(...await listFiles(dir));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  const results = [];
  for (const absolutePath of absoluteFiles.sort()) {
    const source = await fs.readFile(absolutePath, "utf8");
    const file = path.relative(srcDir, absolutePath).split(path.sep).join("/");
    const matches = [];

    for (const pattern of patterns) {
      pattern.regex.lastIndex = 0;
      for (const match of source.matchAll(pattern.regex)) {
        matches.push({
          kind: pattern.kind,
          line: lineForIndex(source, match.index ?? 0),
          sample: String(match[0]).slice(0, 120),
        });
      }
    }

    if (matches.length === 0) continue;
    const classification = classify(file);
    const counts = Object.fromEntries(
      [...new Set(matches.map((match) => match.kind))]
        .sort()
        .map((kind) => [kind, matches.filter((match) => match.kind === kind).length]),
    );
    results.push({
      file,
      category: classification.category,
      followUp: classification.followUp,
      reason: classification.reason,
      total: matches.length,
      counts,
      matches,
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    roots: targetRoots,
    summary: {
      files: results.length,
      occurrences: results.reduce((sum, item) => sum + item.total, 0),
      categories: Object.fromEntries(
        [...new Set(results.map((item) => item.category))]
          .sort()
          .map((category) => [category, results.filter((item) => item.category === category).length]),
      ),
    },
    files: results,
  };
}

function baselineFromReport(report) {
  return {
    version: 1,
    note: "#248 direct database access baseline. Counts may only decrease unless this file is deliberately reviewed and updated.",
    files: Object.fromEntries(
      report.files.map((item) => [item.file, {
        category: item.category,
        followUp: item.followUp,
        counts: item.counts,
      }]),
    ),
  };
}

function renderMarkdown(report) {
  const lines = [
    "# Direct database access audit",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    `- Files with direct access: **${report.summary.files}**`,
    `- Detected occurrences: **${report.summary.occurrences}**`,
    "",
    "## Categories",
    "",
    "| Category | Files |",
    "|---|---:|",
    ...Object.entries(report.summary.categories).map(([category, count]) => `| ${category} | ${count} |`),
    "",
    "## Files",
    "",
    "| File | Category | Follow-up | Occurrences | Kinds |",
    "|---|---|---|---:|---|",
    ...report.files.map((item) => {
      const kinds = Object.entries(item.counts).map(([kind, count]) => `${kind}:${count}`).join(", ");
      return `| \`${item.file}\` | ${item.category} | ${item.followUp} | ${item.total} | ${kinds} |`;
    }),
    "",
  ];
  return `${lines.join("\n")}\n`;
}

async function compareWithBaseline(report) {
  let baseline;
  try {
    baseline = JSON.parse(await fs.readFile(baselinePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`Baseline missing: ${path.relative(process.cwd(), baselinePath)}. Run with --write-baseline after reviewing the audit report.`);
    }
    throw error;
  }

  const violations = [];
  const current = new Map(report.files.map((item) => [item.file, item]));
  for (const item of report.files) {
    const allowed = baseline.files[item.file];
    if (!allowed) {
      violations.push(`${item.file}: new direct database access file (${item.total} occurrence(s))`);
      continue;
    }
    for (const [kind, count] of Object.entries(item.counts)) {
      const allowedCount = allowed.counts?.[kind] ?? 0;
      if (count > allowedCount) {
        violations.push(`${item.file}: ${kind} increased from ${allowedCount} to ${count}`);
      }
    }
  }

  for (const file of Object.keys(baseline.files)) {
    if (!current.has(file)) continue;
    const baselineEntry = baseline.files[file];
    const item = current.get(file);
    if (item.category !== baselineEntry.category || item.followUp !== baselineEntry.followUp) {
      violations.push(`${file}: exception ownership changed without baseline review`);
    }
  }

  if (violations.length > 0) {
    console.error("Direct database access guard failed:\n");
    for (const violation of violations) console.error(`- ${violation}`);
    console.error("\nMigrate the access or deliberately review and update the baseline.");
    process.exitCode = 1;
  } else {
    console.log(`Direct database access guard passed (${report.summary.files} baseline file(s), ${report.summary.occurrences} occurrence(s)).`);
  }
}

const report = await scan();
const markdown = renderMarkdown(report);

if (reportJsonPath) {
  await fs.mkdir(path.dirname(path.resolve(reportJsonPath)), { recursive: true });
  await fs.writeFile(path.resolve(reportJsonPath), `${JSON.stringify(report, null, 2)}\n`);
}
if (reportMdPath) {
  await fs.mkdir(path.dirname(path.resolve(reportMdPath)), { recursive: true });
  await fs.writeFile(path.resolve(reportMdPath), markdown);
}
if (writeBaseline) {
  await fs.writeFile(baselinePath, `${JSON.stringify(baselineFromReport(report), null, 2)}\n`);
  console.log(`Wrote baseline: ${path.relative(process.cwd(), baselinePath)}`);
}

console.log(markdown);
if (check) await compareWithBaseline(report);
