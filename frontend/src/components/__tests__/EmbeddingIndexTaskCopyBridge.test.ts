/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it } from "vitest";

import { applyEmbeddingIndexTaskCopy } from "@/components/EmbeddingIndexTaskCopyBridge";

function renderChineseStatus(vectorState = "不可用") {
  document.body.innerHTML = `
    <section>
      <h3>向量检索（Embedding）</h3>
      <div id="queue-card">
        <div>任务队列</div>
        <div>待处理 34 · 处理中 0 · 失败 0</div>
      </div>
      <div>
        <div>向量引擎</div>
        <div>${vectorState}</div>
      </div>
      <p>索引在后台异步执行；失败任务可通过重新构建索引再次处理。</p>
    </section>
  `;
}

describe("EmbeddingIndexTaskCopyBridge", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("clarifies Chinese queue copy and explains blocked waiting jobs", () => {
    renderChineseStatus();

    expect(applyEmbeddingIndexTaskCopy()).toBe(true);
    expect(document.body.textContent).toContain("索引任务");
    expect(document.body.textContent).toContain("等待 34 · 处理中 0 · 失败 0");
    expect(document.body.textContent).toContain("向量引擎不可用，等待中的索引任务暂时不会开始处理");

    const card = document.querySelector<HTMLElement>("#queue-card");
    expect(card?.dataset.embeddingIndexTaskCard).toBe("");
    expect(card?.getAttribute("aria-describedby")).toBe("embedding-index-task-help");
  });

  it("uses the general explanation when the vector engine is available", () => {
    renderChineseStatus("可用");

    applyEmbeddingIndexTaskCopy();

    expect(document.body.textContent).toContain("不是待办事项或聊天排队");
    expect(document.body.textContent).not.toContain("暂时不会开始处理");
  });

  it("is idempotent and supports English copy", () => {
    document.body.innerHTML = `
      <section>
        <h3>Vector search (Embedding)</h3>
        <div id="queue-card"><div>Queue</div><div>pending 2 · processing 1 · failed 0</div></div>
        <div><div>Vector engine</div><div>Ready</div></div>
        <p>Indexing runs in the background. Failed jobs can be retried by rebuilding the index.</p>
      </section>
    `;

    applyEmbeddingIndexTaskCopy();
    const once = document.body.innerHTML;
    applyEmbeddingIndexTaskCopy();

    expect(document.body.innerHTML).toBe(once);
    expect(document.body.textContent).toContain("Index jobs");
    expect(document.body.textContent).toContain("waiting 2 · processing 1 · failed 0");
  });
});
