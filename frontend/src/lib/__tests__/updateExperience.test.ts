import { describe, expect, it } from "vitest";
import {
  clampUpdatePercent,
  compactReleaseNotes,
  formatUpdateBytes,
  resolveUpdatePhase,
  shouldShowAvailablePrompt,
  updateStatusText,
} from "@/lib/updateExperience";

describe("desktop update experience helpers", () => {
  it("maps legacy updater statuses to the explicit state machine", () => {
    expect(resolveUpdatePhase({ status: "available" })).toBe("update-available");
    expect(resolveUpdatePhase({ status: "not-available" })).toBe("up-to-date");
    expect(resolveUpdatePhase({ status: "preparing-install" })).toBe("installing");
    expect(resolveUpdatePhase({ phase: "downloading", status: "available" })).toBe("downloading");
  });

  it("clamps progress and formats real byte counters", () => {
    expect(clampUpdatePercent(-3)).toBe(0);
    expect(clampUpdatePercent(56.78)).toBe(56.78);
    expect(clampUpdatePercent(130)).toBe(100);
    expect(formatUpdateBytes(1024)).toBe("1.00 KB");
    expect(formatUpdateBytes(12 * 1024 * 1024)).toBe("12.0 MB");
    expect(formatUpdateBytes(undefined)).toBe("—");
  });

  it("turns release markdown into compact readable text", () => {
    expect(compactReleaseNotes("## 新增\n\n- [详情](https://example.com)\r\n\r\n修复问题"))
      .toBe("新增\n\n- 详情\n\n修复问题");
  });

  it("does not reopen a dismissed version during the same session", () => {
    const snapshot = { phase: "update-available" as const, version: "1.4.0" };
    expect(shouldShowAvailablePrompt(snapshot, new Set())).toBe(true);
    expect(shouldShowAvailablePrompt(snapshot, new Set(["1.4.0"]))).toBe(false);
  });

  it("describes downloaded and armed states clearly", () => {
    expect(updateStatusText({ phase: "downloaded", version: "1.4.0" }))
      .toBe("更新已下载完成");
    expect(updateStatusText({ phase: "downloaded", version: "1.4.0", installOnQuit: true }))
      .toBe("已下载，退出应用时安装");
  });
});
