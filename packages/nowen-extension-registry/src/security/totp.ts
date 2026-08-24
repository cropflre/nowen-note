import crypto from "node:crypto";

function decodeBase32(value: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const character of value.toUpperCase().replace(/=|\s|-/g, "")) {
    const index = alphabet.indexOf(character);
    if (index < 0) throw new Error("invalid TOTP secret");
    bits += index.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let offset = 0; offset + 8 <= bits.length; offset += 8) bytes.push(Number.parseInt(bits.slice(offset, offset + 8), 2));
  return Buffer.from(bytes);
}
function codeAt(secret: string, counter: number): string {
  const value = Buffer.alloc(8);
  value.writeBigUInt64BE(BigInt(counter));
  const mac = crypto.createHmac("sha1", decodeBase32(secret)).update(value).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const binary = ((mac[offset]! & 0x7f) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!;
  return String(binary % 1_000_000).padStart(6, "0");
}

export function verifyTotp(secret: string, candidate: string, timestamp = Date.now()): boolean {
  if (!/^\d{6}$/.test(candidate)) return false;
  const counter = Math.floor(timestamp / 30_000);
  return [-1, 0, 1].some((drift) => {
    const expected = Buffer.from(codeAt(secret, counter + drift));
    const actual = Buffer.from(candidate);
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  });
}

export function encryptSecret(secret: string, keyMaterial: string): { ciphertext: string; iv: string; tag: string } {
  const key = crypto.createHash("sha256").update(keyMaterial).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return { ciphertext: ciphertext.toString("base64"), iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64") };
}

export function decryptSecret(ciphertext: string, iv: string, tag: string, keyMaterial: string): string {
  const key = crypto.createHash("sha256").update(keyMaterial).digest();
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64")), decipher.final()]).toString("utf8");
}
