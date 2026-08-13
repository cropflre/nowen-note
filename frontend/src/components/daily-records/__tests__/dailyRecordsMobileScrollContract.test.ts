import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function source(relativeUrl: string) {
  return readFileSync(new URL(relativeUrl, import.meta.url), "utf8");
}

describe("daily records mobile scroll contract", () => {
  it("allows every flex layer above the moments timeline to shrink", () => {
    const app = source("../../../App.tsx");
    const hub = source("../DailyRecordsHub.tsx");
    const diary = source("../../DiaryCenterImpl.tsx");

    expect(app).toContain('className="flex-1 min-h-0 min-w-0 flex flex-col overflow-hidden"');
    expect(hub).toContain('className="flex min-h-0 min-w-0 flex-1 overflow-hidden"');
    expect(diary).toContain('className="flex min-h-0 flex-1 flex-col h-full overflow-hidden bg-app-bg"');
    expect(diary).toContain('className="flex min-h-0 flex-1 overflow-hidden"');
    expect(diary).toContain('className="flex min-h-0 flex-1 justify-center overflow-hidden"');
  });

  it("keeps the moments timeline as the bounded vertical scroll owner", () => {
    const diary = source("../../DiaryCenterImpl.tsx");

    expect(diary).toContain('<ScrollArea className="h-full min-h-0 flex-1 max-w-[760px]"');
  });
});
