/**
 * UI guard for manually entered models. The server performs the authoritative
 * check (including provider metadata) before sending any chat request.
 */
export type NonChatModelKind = "embedding" | "rerank";

export function getNonChatModelKind(modelId: string): NonChatModelKind | null {
  const id = modelId.trim();
  if (/(?:^|[/:._-])(?:rerank(?:er|ing)?|bge-reranker)(?=$|[/:._-])/i.test(id)) return "rerank";
  if (/(?:^|[/:._-])(?:bge-(?!rerank|reranker)[a-z0-9.-]+|qwen3-embedding(?:[-a-z0-9.]*)?|(?:text-)?embeddings?(?:[-a-z0-9.]*)?|nomic-embed(?:[-a-z0-9.]*)?|mxbai-embed(?:[-a-z0-9.]*)?|jina-embeddings?(?:[-a-z0-9.]*)?|multilingual-e5(?:[-a-z0-9.]*)?|e5-(?:small|base|large|mistral)[a-z0-9.-]*|gte-(?:small|base|large|multilingual|qwen)[a-z0-9.-]*|text2vec(?:[-a-z0-9.]*)?|snowflake-arctic-embed(?:[-a-z0-9.]*)?)(?=$|[/:._-])/i.test(id)) {
    return "embedding";
  }
  return null;
}
