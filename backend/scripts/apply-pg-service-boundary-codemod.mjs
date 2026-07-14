import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(here, "..");

function update(relativePath, replacements) {
  const filePath = path.join(backendRoot, relativePath);
  let source = fs.readFileSync(filePath, "utf8");
  for (const { from, to, label } of replacements) {
    if (!source.includes(from)) {
      throw new Error(`${relativePath}: missing expected fragment: ${label}`);
    }
    source = source.replace(from, to);
  }
  fs.writeFileSync(filePath, source);
}

update("src/services/realtime.ts", [
  {
    label: "realtime database import",
    from: 'import { getDb } from "../db/schema";',
    to: 'import { realtimeAuthRepository } from "../repositories/realtimeAuthRepository";',
  },
  {
    label: "realtime user lookup",
    from: `    const db = getDb();
    const user = db
      .prepare("SELECT id, username, isDisabled, tokenVersion FROM users WHERE id = ?")
      .get(payload.userId) as
      | { id: string; username: string; isDisabled: number; tokenVersion: number }
      | undefined;`,
    to: `    const user = realtimeAuthRepository.findById(payload.userId);`,
  },
]);

update("src/services/image-hosting.ts", [
  {
    label: "image hosting database import",
    from: 'import { getDb } from "../db/schema";',
    to: 'import { systemSettingsRepository } from "../repositories/systemSettingsRepository";',
  },
  {
    label: "image hosting config read",
    from: `    const row = getDb()
      .prepare("SELECT value, updatedAt FROM system_settings WHERE key = ?")
      .get(SETTING_KEY) as { value: string; updatedAt: string } | undefined;`,
    to: `    const row = systemSettingsRepository.get(SETTING_KEY);`,
  },
  {
    label: "image hosting config write",
    from: `  getDb().prepare(\`
    INSERT INTO system_settings (key, value, updatedAt)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updatedAt = excluded.updatedAt
  \`).run(SETTING_KEY, JSON.stringify(config));`,
    to: `  systemSettingsRepository.set(SETTING_KEY, JSON.stringify(config));`,
  },
  {
    label: "image hosting config delete",
    from: `  getDb().prepare("DELETE FROM system_settings WHERE key = ?").run(SETTING_KEY);`,
    to: `  systemSettingsRepository.delete(SETTING_KEY);`,
  },
]);

update("src/services/attachment-storage.ts", [
  {
    label: "attachment storage database import",
    from: 'import { getDb } from "../db/schema";',
    to: 'import { systemSettingsRepository } from "../repositories/systemSettingsRepository";',
  },
  {
    label: "attachment storage config read",
    from: `    const row = getDb()
      .prepare("SELECT value, updatedAt FROM system_settings WHERE key = ?")
      .get(SETTING_KEY) as { value: string; updatedAt: string } | undefined;`,
    to: `    const row = systemSettingsRepository.get(SETTING_KEY);`,
  },
  {
    label: "attachment storage config write",
    from: `  getDb()
    .prepare(
      \`INSERT INTO system_settings (key, value, updatedAt)
       VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updatedAt = datetime('now')\`,
    )
    .run(SETTING_KEY, value);`,
    to: `  systemSettingsRepository.set(SETTING_KEY, value);`,
  },
  {
    label: "attachment storage config delete",
    from: `  getDb().prepare("DELETE FROM system_settings WHERE key = ?").run(SETTING_KEY);`,
    to: `  systemSettingsRepository.delete(SETTING_KEY);`,
  },
]);

console.log("Applied PostgreSQL service boundary codemod.");
