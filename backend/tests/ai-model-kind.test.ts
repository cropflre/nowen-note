import assert from "node:assert/strict";
import test from "node:test";
import { nonChatModelKind } from "../src/services/ai-model-kind";

test("recognizes embeddings and rerankers across provider catalogs", () => {
  for (const id of [
    "BAAI/bge-m3",
    "BAAI/bge-large-zh-v1.5",
    "text-embedding-3-small",
    "Qwen/Qwen3-Embedding-0.6B",
    "nomic-embed-text",
    "jina-embeddings-v3",
    "intfloat/multilingual-e5-large",
    "Alibaba-NLP/gte-Qwen2-1.5B-instruct",
  ]) assert.equal(nonChatModelKind(id), "embedding", id);
  for (const id of ["BAAI/bge-reranker-v2-m3", "Qwen/Qwen3-Reranker-0.6B"]) {
    assert.equal(nonChatModelKind(id), "rerank", id);
  }
});

test("preserves chat and unknown custom models", () => {
  for (const id of ["deepseek-ai/DeepSeek-V4-Flash", "gpt-4.1", "qwen3:8b", "my-private-model", "embedder-chat"]) {
    assert.equal(nonChatModelKind(id), null, id);
  }
  assert.equal(nonChatModelKind("custom", { task: "feature-extraction" }), "embedding");
  assert.equal(nonChatModelKind("custom", { capabilities: { reranking: true } }), "rerank");
  assert.equal(nonChatModelKind("multipurpose", { capabilities: { chat: true, embedding: true } }), null);
});
