import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function source(relativeUrl: string): string {
  return readFileSync(new URL(relativeUrl, import.meta.url), "utf8").replace(/\r\n/g, "\n");
}

describe("AI 问答布局收缩契约", () => {
  it("主内容外层允许 AI 面板在应用 Flex 中收缩", () => {
    const app = source("../../App.tsx");

    expect(app).toContain(
      'isAIChatView ? (\n        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">',
    );
  });

  it("可靠性外壳限制横向溢出", () => {
    const shell = source("../../components/AIChatReliabilityShell.tsx");

    expect(shell).toContain(
      '<div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-app-bg">',
    );
  });
});
