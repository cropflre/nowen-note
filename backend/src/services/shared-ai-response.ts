import { AppError } from "../lib/app-error";
import type { AISettings } from "./ai-client";
import { normalizeAIHeaders, redactAICredentials } from "./ai-provider-config";

/** Redact shared credentials at the server boundary, including raw JSON and SSE consumers. */
export async function redactSharedAIResponse(response: Response, settings: AISettings): Promise<Response> {
  const redact = (value: string) => {
    let clean = redactAICredentials(value, settings.ai_api_key, settings.ai_custom_headers);
    for (const secret of [settings.ai_api_key, ...Object.values(normalizeAIHeaders(settings.ai_custom_headers))].filter(Boolean)) {
      clean = clean.split(JSON.stringify(secret).slice(1, -1)).join("****");
    }
    return clean;
  };
  const redactValues = (value: unknown): unknown => {
    if (typeof value === "string") return redact(value);
    if (Array.isArray(value)) return value.map(redactValues);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [redact(key), redactValues(entry)]));
    return value;
  };
  const headers = new Headers({
    "Content-Type": response.headers.get("content-type") || "application/json",
    "X-Nowen-AI-Provider": settings.ai_provider,
    "Cache-Control": "no-store",
  });
  if (!response.body) return new Response(null, { status: response.status, headers });
  if (!headers.get("Content-Type")!.includes("text/event-stream")) {
    const data = await response.json().catch(() => { throw new AppError("AI_SHARED_UPSTREAM_ERROR", "共享模型返回了无效响应", { status: 502 }); });
    return new Response(JSON.stringify(redactValues(data)), { status: response.status, headers });
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = "";
  return new Response(new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await reader.read();
        pending += decoder.decode(value, { stream: !done });
        const end = done ? pending.length : pending.lastIndexOf("\n") + 1;
        if (end) {
          const lines = pending.slice(0, end).split("\n").map(line => {
            if (!line.startsWith("data:") || line.slice(5).trim() === "[DONE]") return redact(line);
            try { return `data: ${JSON.stringify(redactValues(JSON.parse(line.slice(5).trim())))}`; }
            catch { return redact(line); }
          }).join("\n");
          controller.enqueue(encoder.encode(lines)); pending = pending.slice(end);
        }
        if (pending.length > 1_000_000) throw new Error("AI_STREAM_LIMIT");
        if (done) { controller.close(); reader.releaseLock(); }
      } catch { controller.error(new Error("共享模型返回中断，请重试")); void reader.cancel().catch(() => undefined); }
    },
    cancel(reason) { return reader.cancel(reason); },
  }), { status: response.status, headers });
}
