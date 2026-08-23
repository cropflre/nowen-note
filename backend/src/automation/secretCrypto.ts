import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function loadKey(): Buffer {
  const target = path.join(process.env.ELECTRON_USER_DATA || path.join(process.cwd(), "data"), ".plugin_secret_key");
  if (!fs.existsSync(target)) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, crypto.randomBytes(32), { flag: "wx", mode: 0o600 });
  }
  const key = fs.readFileSync(target);
  if (key.length !== 32) throw new Error("Automation Secret Key 长度无效");
  return key;
}

export function encryptAutomationSecret(value: string): { encrypted: string; iv: string; tag: string } {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", loadKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return { encrypted: encrypted.toString("base64"), iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64") };
}

export function decryptAutomationSecret(encrypted: string, iv: string, tag: string): string {
  const decipher = crypto.createDecipheriv("aes-256-gcm", loadKey(), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(encrypted, "base64")), decipher.final()]).toString("utf8");
}
