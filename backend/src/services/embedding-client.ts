import { aiOutboundFetch } from "./ai-outbound-fetch.js";
import type { EmbeddingConfig } from "./embedding-config.js";

export async function callEmbeddings(
  cfg: EmbeddingConfig,
  inputs: string[],
  signal?: AbortSignal,
): Promise<number[][]> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cfg.apiKey) headers["Authorization"] = `Bearer ${cfg.apiKey}`;

  const res = await aiOutboundFetch(`${cfg.url}/embeddings`, {
    method: "POST",
    headers,
    body: JSON.stringify({ model: cfg.model, input: inputs }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${errText.slice(0, 300)}`);
  }
  const data = (await res.json()) as {
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
}
