/**
 * Conservative classification for models listed by OpenAI-compatible providers.
 * Unknown models stay selectable: provider catalogs are not standardized.
 */
export type NonChatModelKind = "embedding" | "rerank";

const RERANK_ID = /(?:^|[/:._-])(?:rerank(?:er|ing)?|bge-reranker)(?=$|[/:._-])/i;
const EMBEDDING_ID = /(?:^|[/:._-])(?:bge-(?!rerank|reranker)[a-z0-9.-]+|qwen3-embedding(?:[-a-z0-9.]*)?|(?:text-)?embeddings?(?:[-a-z0-9.]*)?|nomic-embed(?:[-a-z0-9.]*)?|mxbai-embed(?:[-a-z0-9.]*)?|jina-embeddings?(?:[-a-z0-9.]*)?|multilingual-e5(?:[-a-z0-9.]*)?|e5-(?:small|base|large|mistral)[a-z0-9.-]*|gte-(?:small|base|large|multilingual|qwen)[a-z0-9.-]*|text2vec(?:[-a-z0-9.]*)?|snowflake-arctic-embed(?:[-a-z0-9.]*)?)(?=$|[/:._-])/i;

function capabilityText(metadata: unknown): string {
  if (!metadata || typeof metadata !== "object") return "";
  const row = metadata as Record<string, unknown>;
  return [row.type, row.task, row.category, row.capability, row.capabilities]
    .map((value) => {
      if (Array.isArray(value)) return value.join(" ");
      if (value && typeof value === "object") {
        return Object.entries(value)
          .filter(([, enabled]) => enabled === true || enabled === "true")
          .map(([key]) => key)
          .join(" ");
      }
      return typeof value === "string" ? value : "";
    })
    .join(" ")
    .toLowerCase();
}

export function nonChatModelKind(modelId: string, metadata?: unknown): NonChatModelKind | null {
  const id = modelId.trim();
  if (RERANK_ID.test(id)) return "rerank";
  if (EMBEDDING_ID.test(id)) return "embedding";

  const capabilities = capabilityText(metadata);
  // Multi-purpose models advertising chat are not excluded based on metadata alone.
  if (/(?:chat|conversational|text-generation)/.test(capabilities)) return null;
  if (/(?:rerank|cross-encoder)/.test(capabilities)) return "rerank";
  if (/(?:embedding|feature-extraction|sentence-similarity)/.test(capabilities)) return "embedding";
  return null;
}

export function chatModelTypeError(kind: NonChatModelKind): string {
  return kind === "embedding"
    ? "当前选择的是 Embedding 向量模型，不能用于 AI 对话。请在下方「向量检索（Embedding）」中配置和测试。"
    : "当前选择的是 Rerank 重排序模型，不能用于 AI 对话。请选择聊天模型。";
}
