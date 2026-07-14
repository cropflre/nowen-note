import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const filePath = path.resolve(here, "../src/services/email.ts");
let source = fs.readFileSync(filePath, "utf8");

function replaceExact(from, to, label) {
  if (!source.includes(from)) {
    throw new Error(`email.ts: missing expected fragment: ${label}`);
  }
  source = source.replace(from, to);
}

replaceExact(
  'import { getDb } from "../db/schema.js";',
  'import { systemSettingsRepository } from "../repositories/systemSettingsRepository";',
  "database import",
);

replaceExact(
`  const db = getDb();
  const row = db
    .prepare("SELECT value, updatedAt FROM system_settings WHERE key = ?")
    .get(SETTING_KEY) as { value: string; updatedAt: string } | undefined;`,
`  const row = systemSettingsRepository.get(SETTING_KEY);`,
  "smtp config read",
);

replaceExact(
`  const db = getDb();
  const current = readSmtpConfig();`,
`  const current = readSmtpConfig();`,
  "smtp config write db declaration",
);

replaceExact(
`  db.prepare(
    \`INSERT INTO system_settings (key, value, updatedAt)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updatedAt = datetime('now')\`,
  ).run(SETTING_KEY, value);`,
`  systemSettingsRepository.set(SETTING_KEY, value);`,
  "smtp config upsert",
);

fs.writeFileSync(filePath, source);
console.log("Applied email service boundary codemod.");
