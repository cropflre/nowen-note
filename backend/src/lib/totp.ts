/**
 * TOTP (RFC 6238) 自实现 —— 避免引入 otplib/speakeasy 这类依赖。
 *
 * 参数取业界默认值：SHA-1 / 6 位数字 / 30 秒 period，这也是 Google Authenticator、
 * Microsoft Authenticator、1Password、Authy、Bitwarden 等所有主流 Authenticator App
 * 的默认兼容值。自己实现的好处是零新增依赖、代码自闭合、安全审查范围明确。
 *
 * 关键点：
 *   - 验证时允许 ±1 个时间窗（共 90 秒）抵消手机与服务器的时钟漂移；
 *   - 使用 crypto.timingSafeEqual 做常量时间比较，防止通过响应时长侧信道爆破；
 *   - base32 采用 RFC 4648（无 padding）以兼容 otpauth://URI。
 */
import crypto from "crypto";

const DIGITS = 6;
const PERIOD = 30;
const ALGORITHM = "sha1";

// ==== base32 (RFC 4648) ====
const B32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of buf) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += B32_ALPHABET[(value << (5 - bits)) & 0x1f];
  }
  return out;
}

export function base32Decode(input: string): Buffer {
  const cleaned = input.toUpperCase().replace(/=+$/, "").replace(/\s+/g, "");
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const ch of cleaned) {
    const idx = B32_ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error("invalid base32 character");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** 生成一个 20 字节的随机 TOTP secret，返回 base32 字符串（otpauth:// 直接用） */
export function generateTotpSecret(): string {
  return base32Encode(crypto.randomBytes(20));
}

/** 核心：HOTP（RFC 4226）计数器 → 6 位动态码 */
function hotp(secret: Buffer, counter: number): string {
  // counter 按 big-endian 64-bit 写入缓冲
  const buf = Buffer.alloc(8);
  // Node 14+ 支持 BigInt64；使用 BigInt 以避免 2^32 上限
  buf.writeBigUInt64BE(BigInt(counter));

  const hmac = crypto.createHmac(ALGORITHM, secret).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  const mod = 10 ** DIGITS;
  return String(code % mod).padStart(DIGITS, "0");
}

/** 根据 base32 secret + 当前时间戳生成 6 位 TOTP（mainly for tests） */
export function generateTotp(secretBase32: string, now = Date.now()): string {
  const counter = Math.floor(now / 1000 / PERIOD);
  return hotp(base32Decode(secretBase32), counter);
}

/**
 * 校验用户输入的 6 位 TOTP。
 *   - 允许 ±1 个窗口（30 秒）抵消时钟漂移
 *   - 常量时间比较
 */
export function verifyTotp(secretBase32: string, code: string): boolean {
  const clean = (code || "").replace(/\s+/g, "");
  if (!/^\d{6}$/.test(clean)) return false;
  const secret = base32Decode(secretBase32);
  const counter = Math.floor(Date.now() / 1000 / PERIOD);
  for (let offset = -1; offset <= 1; offset++) {
    const expected = hotp(secret, counter + offset);
    // 长度相同，直接做 timingSafeEqual
    const a = Buffer.from(expected);
    const b = Buffer.from(clean);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true;
  }
  return false;
}

/** 构建 otpauth:// URI，按 Google Authenticator Key URI 规范：
 *   otpauth://totp/<issuer>:<account>?secret=...&issuer=...&algorithm=SHA1&digits=6&period=30
 */
export function buildOtpAuthUri(params: {
  issuer: string;
  account: string;
  secretBase32: string;
}): string {
  const label = encodeURIComponent(`${params.issuer}:${params.account}`);
  const qs = new URLSearchParams({
    secret: params.secretBase32,
    issuer: params.issuer,
    algorithm: "SHA1",
    digits: String(DIGITS),
    period: String(PERIOD),
  });
  return `otpauth://totp/${label}?${qs.toString()}`;
}

// ==== 恢复码（Recovery Codes）==== //
// 用户丢失 Authenticator 时可用的一次性密码。存储时 hash，不存明文。
//
// 生成的是 10 位 base32（≈ 50 bits 熵），易手抄；按 `xxxxx-xxxxx` 分组展示。

export function generateRecoveryCodes(count = 8): string[] {
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const raw = base32Encode(crypto.randomBytes(7)).slice(0, 10); // 7*8/5=11.2 → 取 10
    out.push(`${raw.slice(0, 5)}-${raw.slice(5, 10)}`);
  }
  return out;
}

/** 把恢复码做 SHA-256 hash 以存储（比对时也对输入做同样 hash） */
export function hashRecoveryCode(code: string): string {
  return crypto.createHash("sha256").update(code.trim().toUpperCase()).digest("hex");
}
