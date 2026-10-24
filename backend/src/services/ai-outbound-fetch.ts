/**
 * Dedicated outbound network path for AI provider traffic.
 *
 * NOWEN_AI_PROXY_URL is an administrator-managed setting (Docker env). We do
 * not enable an unrestricted system-wide proxy because sync, attachments,
 * private user URLs and the plugin SSRF boundary must remain unaffected.
 */
import { Agent, ProxyAgent, fetch as undiciFetch } from "undici";

const DEFAULT_BYPASS = ["localhost", "127.0.0.1", "::1", "host.docker.internal", ".localhost", ".local"];

export interface AIOutboundProxyStatus {
  enabled: boolean;
  valid: boolean;
  bypass: string[];
  message: string;
}

export function aiProxyBypassRules(env: NodeJS.ProcessEnv = process.env): string[] {
  return [...DEFAULT_BYPASS, ...(env.NOWEN_AI_NO_PROXY || "").split(",")]
    .map((rule) => rule.trim().toLowerCase())
    .filter(Boolean);
}

export function shouldBypassAIProxy(target: URL, env: NodeJS.ProcessEnv = process.env): boolean {
  const host = target.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!/^https?:$/.test(target.protocol)) return true;
  // Local inference servers should not be sent to a public/remote proxy.
  if (host === "::1" || host.startsWith("127.") || host.startsWith("10.") ||
      host.startsWith("192.168.") || /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
      host.startsWith("169.254.") || host.startsWith("fe80:") || host.startsWith("fc") || host.startsWith("fd")) {
    return true;
  }
  return aiProxyBypassRules(env).some((rule) => {
    if (rule === "*") return true;
    const match = rule.startsWith("*.") ? rule.slice(1) : rule;
    if (match.startsWith(".")) return host.endsWith(match) || host === match.slice(1);
    return host === match;
  });
}

function parseProxyURL(env: NodeJS.ProcessEnv): string | null {
  const raw = (env.NOWEN_AI_PROXY_URL || "").trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (!["http:", "https:"].includes(url.protocol) ||
        !url.hostname || url.pathname !== "/" || url.search || url.hash) {
      throw new Error("Invalid proxy format");
    }
    return url.toString();
  } catch {
    throw new Error("NOWEN_AI_PROXY_URL 必须为 HTTP 或 HTTPS 代理地址，请检查服务器环境变量");
  }
}

export function getAIOutboundProxyStatus(env: NodeJS.ProcessEnv = process.env): AIOutboundProxyStatus {
  const enabled = !!env.NOWEN_AI_PROXY_URL?.trim();
  try {
    parseProxyURL(env);
    return {
      enabled, valid: true, bypass: aiProxyBypassRules(env),
      message: enabled ? "AI 服务请求使用服务器出站代理；命中绕过规则的地址仍直连" : "AI 服务请求直连（未配置服务器代理）",
    };
  } catch {
    return { enabled, valid: false, bypass: aiProxyBypassRules(env), message: "AI 代理配置无效，请管理员检查 NOWEN_AI_PROXY_URL" };
  }
}

const cachedProxyAgents = new Map<string, ProxyAgent>();
let longRequestAgent: Agent | null = null;
const LONG_REQUEST_TIMEOUT_MS = 600_000;

/** Mirrors fetch/Response semantics, including SSE streaming and AbortSignal. */
export async function aiOutboundFetch(input: string | URL, init?: RequestInit, timeoutMs?: number): Promise<Response> {
  const target = new URL(String(input));
  const proxy = parseProxyURL(process.env);
  // Undici's default header/body deadlines are 300s. Longer indexing requests
  // need a separate pool so their selected deadline can actually reach 600s.
  const longRequest = (timeoutMs || 0) > 300_000;
  const deadlines = { headersTimeout: LONG_REQUEST_TIMEOUT_MS, bodyTimeout: LONG_REQUEST_TIMEOUT_MS };
  let dispatcher: Agent | ProxyAgent;
  if (!proxy || shouldBypassAIProxy(target)) {
    if (!longRequest) return fetch(target, init);
    dispatcher = longRequestAgent ??= new Agent(deadlines);
  } else {
    const key = `${proxy}:${longRequest}`;
    let agent = cachedProxyAgents.get(key);
    if (!agent) {
      agent = new ProxyAgent({ uri: proxy, ...(longRequest ? deadlines : {}) });
      cachedProxyAgents.set(key, agent);
    }
    dispatcher = agent;
  }
  const options = { ...init, dispatcher } as unknown as Parameters<typeof undiciFetch>[1];
  return await undiciFetch(target.toString(), options) as unknown as Response;
}
