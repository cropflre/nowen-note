import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { computeSingleTextChange } from "@/lib/largeMarkdownSafetyRuntime";
import {
  acquireIncrementalMarkdownYTextSync,
  isIncrementalMarkdownYTextSyncActive,
} from "@/lib/markdownYTextSyncRuntimeState";

describe("large Markdown incremental collaboration runtime", () => {
  it("skips the legacy whole-document diff while an incremental editor is active", () => {
    expect(computeSingleTextChange("alpha", "alpha beta")).toEqual({
      from: 5,
      deleteCount: 0,
      insert: " beta",
    });

    const release = acquireIncrementalMarkdownYTextSync();
    try {
      expect(isIncrementalMarkdownYTextSyncActive()).toBe(true);
      expect(computeSingleTextChange("alpha", "alpha beta")).toBeNull();
    } finally {
      release();
    }

    expect(isIncrementalMarkdownYTextSyncActive()).toBe(false);
    expect(computeSingleTextChange("alpha", "alpha beta")).not.toBeNull();
  });

  it("keeps the bypass active until every mounted editor releases its lease", () => {
    const releaseFirst = acquireIncrementalMarkdownYTextSync();
    const releaseSecond = acquireIncrementalMarkdownYTextSync();

    releaseFirst();
    expect(isIncrementalMarkdownYTextSyncActive()).toBe(true);
    expect(computeSingleTextChange("a", "ab")).toBeNull();

    releaseSecond();
    expect(isIncrementalMarkdownYTextSyncActive()).toBe(false);
  });

  it("keeps both local and remote incremental paths in the runtime shell", () => {
    const source = readFileSync(
      new URL("../../components/LargeMarkdownSafeEditorRuntime.tsx", import.meta.url),
      "utf-8",
    );

    expect(source).toContain("EditorView.findFromDOM");
    expect(source).toContain("StateEffect.appendConfig");
    expect(source).toContain("applyCodeMirrorChangesToYText");
    expect(source).toContain("yTextDeltaToCodeMirrorChanges");
    expect(source).toContain("yText.observe(handleRemoteUpdate)");
  });
});
