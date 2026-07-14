const PASSWORD_KEYS = new Set([
  "password",
  "passwd",
  "pass",
  "pwd",
  "passcode",
  "accesscode",
  "access_code",
  "extractcode",
  "extract_code",
  "code",
  "提取码",
]);

const PASSWORD_INPUT_SELECTOR = [
  'input[type="password"]',
  'input[name*="password" i]',
  'input[id*="password" i]',
  'input[name="pwd" i]',
  'input[id="pwd" i]',
  'input[name*="passcode" i]',
  'input[id*="passcode" i]',
  'input[name*="access-code" i]',
  'input[id*="access-code" i]',
  'input[autocomplete="current-password"]',
].join(",");

function normalizePassword(value: string | null): string | null {
  const password = (value || "").trim();
  if (!password || password.length > 256 || /[\u0000-\u001f\u007f]/.test(password)) return null;
  return password;
}

function readPassword(params: URLSearchParams): string | null {
  for (const [key, value] of params.entries()) {
    if (!PASSWORD_KEYS.has(key.replace(/[\s_-]/g, "").toLowerCase()) && !PASSWORD_KEYS.has(key.toLowerCase())) {
      continue;
    }
    const password = normalizePassword(value);
    if (password) return password;
  }
  return null;
}

export function extractEmbedPassword(rawUrl: string, baseUrl?: string): string | null {
  if (!rawUrl.trim()) return null;
  try {
    const parsed = new URL(rawUrl, baseUrl || (typeof window !== "undefined" ? window.location.href : "https://nowen.local/"));
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;

    const queryPassword = readPassword(parsed.searchParams);
    if (queryPassword) return queryPassword;

    const hash = parsed.hash.replace(/^#/, "");
    if (!hash) return null;
    const hashPassword = readPassword(new URLSearchParams(hash.replace(/^\?/, "")));
    if (hashPassword) return hashPassword;

    const decodedHash = decodeURIComponent(hash);
    const inlineMatch = decodedHash.match(/(?:^|[?&#;\s])(password|passwd|pass|pwd|passcode|access[_-]?code|extract[_-]?code|提取码)\s*[:=]\s*([^&#;\s]+)/i);
    return normalizePassword(inlineMatch?.[2] || null);
  } catch {
    return null;
  }
}

function setNativeInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (setter) setter.call(input, value);
  else input.value = value;
}

export function fillEmbedPasswordDocument(doc: Document, password: string): boolean {
  const safePassword = normalizePassword(password);
  if (!safePassword) return false;
  const input = doc.querySelector<HTMLInputElement>(PASSWORD_INPUT_SELECTOR);
  if (!input || input.disabled || input.readOnly) return false;
  if (input.value === safePassword) return true;

  setNativeInputValue(input, safePassword);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}
