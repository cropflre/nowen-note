import { describe, expect, it } from "vitest";
import type { Notebook } from "@/types";
import { buildNotebookTree, reuseNotebookTreeReferences } from "@/lib/notebookSort";

type Shape = "roots" | "four-level";
type Expansion = "all" | "current-path";

function makeNotebooks(count: number, shape: Shape, expansion: Expansion): Notebook[] {
  const now = "2026-07-18T00:00:00.000Z";
  return Array.from({ length: count }, (_, index) => {
    const depth = shape === "four-level" ? index % 4 : 0;
    const parentIndex = depth === 0 ? null : index - 1;
    return {
      id: `notebook-${index.toString().padStart(4, "0")}`,
      userId: "phase-b-user",
      workspaceId: null,
      parentId: parentIndex === null ? null : `notebook-${parentIndex.toString().padStart(4, "0")}`,
      name: `Notebook ${index}`,
      description: null,
      icon: "📒",
      color: null,
      sortOrder: index,
      isExpanded: expansion === "all" || depth < 3 ? 1 : 0,
      createdAt: now,
      updatedAt: now,
      noteCount: 0,
    };
  });
}

function percentile(values: number[], ratio: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index];
}

describe("Phase B notebook tree baseline", () => {
  it("records repeatable tree-build timings and reference churn", () => {
    const results: Array<Record<string, string | number>> = [];

    for (const count of [10, 100, 500, 1000]) {
      for (const shape of ["roots", "four-level"] as const) {
        for (const expansion of ["all", "current-path"] as const) {
          const notebooks = makeNotebooks(count, shape, expansion);
          for (let warmup = 0; warmup < 5; warmup += 1) buildNotebookTree(notebooks);

          const samples: number[] = [];
          let stableReferences = 0;
          let previousTree = buildNotebookTree(notebooks);
          for (let run = 0; run < 50; run += 1) {
            const startedAt = performance.now();
            const tree = reuseNotebookTreeReferences(buildNotebookTree(notebooks), previousTree);
            samples.push(performance.now() - startedAt);
            if (tree[0] === previousTree[0]) {
              stableReferences += 1;
            }
            previousTree = tree;
          }

          results.push({
            count,
            shape,
            expansion,
            median: Number(percentile(samples, 0.5).toFixed(3)),
            p75: Number(percentile(samples, 0.75).toFixed(3)),
            p95: Number(percentile(samples, 0.95).toFixed(3)),
            max: Number(Math.max(...samples).toFixed(3)),
            samples: samples.length,
            stableRootReferenceRuns: stableReferences,
          });
        }
      }
    }

    console.log(`PHASE_B_TREE_OPTIMIZED ${JSON.stringify(results)}`);
    expect(results).toHaveLength(16);
    expect(results.every((result) => result.stableRootReferenceRuns === 50)).toBe(true);
  });
});
