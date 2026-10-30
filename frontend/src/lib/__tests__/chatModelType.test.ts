import { describe, expect, it } from "vitest";
import { getNonChatModelKind } from "../chatModelType";

describe("getNonChatModelKind", () => {
  it("detects manually entered embedding and rerank models", () => {
    expect(getNonChatModelKind("BAAI/bge-m3")).toBe("embedding");
    expect(getNonChatModelKind("text-embedding-3-small")).toBe("embedding");
    expect(getNonChatModelKind("Qwen/Qwen3-Embedding-0.6B")).toBe("embedding");
    expect(getNonChatModelKind("BAAI/bge-reranker-v2-m3")).toBe("rerank");
  });

  it("does not block chat and unknown custom models", () => {
    for (const model of ["deepseek-ai/DeepSeek-V4-Flash", "gpt-4o", "qwen3:8b", "custom"]) {
      expect(getNonChatModelKind(model)).toBeNull();
    }
  });
});
