import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getDb } from "../db/schema.js";

function keyPath(): string {
  return path.join(process.env.ELECTRON_USER_DATA || path.join(process.cwd(), "data"), ".plugin_secret_key");
}

function loadKey(): Buffer {
  const target = keyPath();
  if (!fs.existsSync(target)) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, crypto.randomBytes(32), { flag: "wx", mode: 0o600 });
  }
  const key = fs.readFileSync(target);
  if (key.length !== 32) throw new Error("插件 Secret Key 长度无效");
  return key;
}

export class PluginSecrets {
  list(pluginId: string, ownerUserId: string): Array<{ name: string; createdAt: string; updatedAt: string }> {
    return getDb().prepare(
      "SELECT name, createdAt, updatedAt FROM plugin_secrets WHERE pluginId=? AND ownerUserId=? ORDER BY name",
    ).all(pluginId, ownerUserId) as Array<{ name: string; createdAt: string; updatedAt: string }>;
  }

  set(pluginId: string, ownerUserId: string, name: string, value: string): void {
    if (!/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(name)) throw new Error("连接名称格式无效");
    if (!value || Buffer.byteLength(value, "utf8") > 64 * 1024) throw new Error("Secret 必须在 1-64KB 之间");
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", loadKey(), iv);
    const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    const timestamp = new Date().toISOString();
    getDb().prepare(`
      INSERT INTO plugin_secrets (id, pluginId, ownerUserId, name, encryptedValue, iv, authTag, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(pluginId, ownerUserId, name) DO UPDATE SET
        encryptedValue=excluded.encryptedValue, iv=excluded.iv, authTag=excluded.authTag, updatedAt=excluded.updatedAt
    `).run(crypto.randomUUID(), pluginId, ownerUserId, name, encrypted.toString("base64"), iv.toString("base64"), tag.toString("base64"), timestamp, timestamp);
  }

  get(pluginId: string, ownerUserId: string, name: string): string {
    const row = getDb().prepare(
      "SELECT encryptedValue, iv, authTag FROM plugin_secrets WHERE pluginId=? AND ownerUserId=? AND name=?",
    ).get(pluginId, ownerUserId, name) as { encryptedValue: string; iv: string; authTag: string } | undefined;
    if (!row) throw new Error(`插件连接不存在: ${name}`);
    const decipher = crypto.createDecipheriv("aes-256-gcm", loadKey(), Buffer.from(row.iv, "base64"));
    decipher.setAuthTag(Buffer.from(row.authTag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(row.encryptedValue, "base64")), decipher.final()]).toString("utf8");
  }

  remove(pluginId: string, ownerUserId: string, name: string): void {
    getDb().prepare("DELETE FROM plugin_secrets WHERE pluginId=? AND ownerUserId=? AND name=?")
      .run(pluginId, ownerUserId, name);
  }
}
