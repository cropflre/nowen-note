import { buildAIHeaders, readAIResponse, redactAICredentials } from "./ai-provider-config";
import { aiOutboundFetch } from "./ai-outbound-fetch.js";
import type { EmbeddingConfig } from "./embedding-config.js";
import { DEFAULT_EMBEDDING_TIMEOUT_SECONDS } from "./embedding-timeout";

export async function callEmbeddings(
  cfg: EmbeddingConfig,
  inputs: string[],
  signal?: AbortSignal,
  timeoutMs = DEFAULT_EMBEDDING_TIMEOUT_SECONDS * 1000,
): Promise<number[][]> {
  const headers = buildAIHeaders("openai", cfg.apiKey, cfg.customHeaders);

  const startedAt = performance.now();
  const deadline = AbortSignal.timeout(timeoutMs);
  const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  try {
    const res = await aiOutboundFetch(`${cfg.url}/embeddings`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: cfg.model, input: inputs }),
      signal: requestSignal,
      redirect: "error",
    }, timeoutMs);

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}: ${redactAICredentials(errText, cfg.apiKey, cfg.customHeaders).slice(0, 300)}`);
    }
    const data = (await readAIResponse(res)) as {
      data?: { embedding: number[]; index?: number }[];
    };
    if (!data.data || !Array.isArray(data.data)) {
      throw new Error("响应缺少 data 数组");
    }
    // 按 index 排序；很多 provider 已经按顺序返回，这里防御一下
    const sorted = [...data.data].sort(
      (a, b) => (a.index ?? 0) - (b.index ?? 0),
    );
    const vectors = sorted.map((d) => d.embedding);
    if (vectors.length !== inputs.length) {
      throw new Error(`返回向量数量 ${vectors.length} 与请求数 ${inputs.length} 不匹配`);
    }
    return vectors;
  } catch (error) {
    if (deadline.aborted && requestSignal.reason === deadline.reason) {
      const timeoutError = new Error(`Embedding request timed out after ${Math.round(performance.now() - startedAt)}ms (limit: ${timeoutMs}ms)`);
      timeoutError.name = "TimeoutError";
      throw timeoutError;
    }
    throw error;
  }
}
