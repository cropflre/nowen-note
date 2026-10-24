export type AICustomHeaders = Record<string, string>;

const MASK = "****";
const RESERVED_HEADERS = new Set([
  "host", "content-length", "content-type", "connection", "transfer-encoding",
  "keep-alive", "upgrade", "trailer", "te", "proxy-authorization", "proxy-connection",
]);

/** Header values are credentials: public APIs return a placeholder, never the value. */
export function normalizeAIHeaders(input: unknown, current: AICustomHeaders = {}): AICustomHeaders {
  if (input === undefined || input === "") return { ...current };
  if (typeof input === "string") {
    try { input = JSON.parse(input); } catch { throw new Error("自定义请求头必须为 JSON 对象"); }
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("自定义请求头必须为键值对象");
  const entries = Object.entries(input);
  if (entries.length > 32) throw new Error("自定义请求头最多 32 项");
  const result: AICustomHeaders = {};
  let size = 0;
  for (const [rawName, rawValue] of entries) {
    const name = rawName.trim().toLowerCase();
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name) || RESERVED_HEADERS.has(name)) {
      throw new Error("自定义请求头名称无效，或属于受保护的 HTTP 请求头");
    }
    if (Object.hasOwn(result, name)) throw new Error("自定义请求头名称重复（不区分大小写）");
    if (typeof rawValue !== "string" || /[^\t\x20-\x7e\x80-\xff]/.test(rawValue)) {
      throw new Error("自定义请求头值无效，不能包含换行或非 HTTP 字符");
    }
    const value = rawValue === MASK ? (Object.hasOwn(current, name) ? current[name] : undefined) : rawValue.trim();
    if (value === undefined) throw new Error("请重新输入新增或重命名请求头的值");
    size += name.length + value.length;
    if (size > 16_384) throw new Error("自定义请求头总长度不能超过 16 KB");
    Object.defineProperty(result, name, { value, enumerable: true, writable: true, configurable: true });
  }
  return result;
}

export function maskAIHeaders(input: unknown): AICustomHeaders {
  return Object.fromEntries(Object.keys(normalizeAIHeaders(input)).map((name) => [name, MASK]));
}

export function buildAIHeaders(provider: string, apiKey: string, customHeaders?: unknown): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (provider === "anthropic") {
    headers["anthropic-version"] = "2023-06-01";
    if (apiKey) headers["x-api-key"] = apiKey;
  } else if (apiKey) {
    headers.authorization = `Bearer ${apiKey}`;
  }
  return { ...headers, ...normalizeAIHeaders(customHeaders) };
}

export function hasAIAuth(settings: { ai_provider: string; ai_api_key: string; ai_custom_headers?: string }): boolean {
  return ["ollama", "lmstudio"].includes(settings.ai_provider)
    || !!settings.ai_api_key
    || Object.values(normalizeAIHeaders(settings.ai_custom_headers)).some(Boolean);
}

export function redactAICredentials(text: unknown, apiKey: string, customHeaders?: unknown): string {
  let result = String(text || "");
  const secrets = [apiKey, ...Object.values(normalizeAIHeaders(customHeaders))].filter(Boolean).sort((a, b) => b.length - a.length);
  for (const value of secrets) result = result.split(value).join(MASK);
  return result;
}

/** Malformed upstream JSON can contain credentials in the parser's error snippet. */
export async function readAIResponse(response: Response): Promise<Record<string, unknown>> {
  try { return await response.json() as Record<string, unknown>; }
  catch { throw new Error("AI 服务返回了无法解析的 JSON"); }
}
