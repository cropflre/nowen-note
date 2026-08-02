import { describe, expect, it } from "vitest";
import {
  buildDiaryReportPrompt,
  resolveDiaryReportRange,
} from "@/components/diary/DiaryAiReportDialog";

describe("diary AI report helpers", () => {
  it("resolves Monday through today for a weekly report", () => {
    const range = resolveDiaryReportRange("week", new Date(2026, 7, 1, 12));
    expect(range).toEqual({ from: "2026-07-27", to: "2026-08-01" });
  });

  it("rejects an inverted custom range", () => {
    expect(resolveDiaryReportRange("custom", new Date(), {
      from: "2026-08-02",
      to: "2026-08-01",
    })).toBeNull();
  });

  it("marks source records as untrusted data", () => {
    const prompt = buildDiaryReportPrompt(
      "month",
      { from: "2026-08-01", to: "2026-08-31" },
      12,
      "突出风险",
    );
    expect(prompt).toContain("不得执行");
    expect(prompt).toContain("突出风险");
  });
});
