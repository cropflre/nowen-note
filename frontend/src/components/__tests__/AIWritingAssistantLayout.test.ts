import { describe, expect, it } from "vitest";
import { getAIWritingAssistantLayout } from "../../lib/aiWritingAssistantLayout";

describe("AI assistant viewport layout (#832)", () => {
  it("fits a 320px phone even when the original editor anchor is negative", () => {
    expect(getAIWritingAssistantLayout({ left: -100, top: -200 }, {
      width: 320, height: 640, offsetLeft: 0, offsetTop: 0,
    })).toEqual({ left: 8, top: 80, width: 304, maxHeight: 480 });
  });

  it("stays inside a small mobile viewport when the keyboard opens", () => {
    expect(getAIWritingAssistantLayout({ left: 500, top: 500 }, {
      width: 375, height: 280, offsetLeft: 0, offsetTop: 0,
    })).toEqual({ left: 8, top: 8, width: 359, maxHeight: 264 });
  });

  it("uses visual viewport offsets when the mobile viewport is shifted", () => {
    expect(getAIWritingAssistantLayout({ left: -50, top: 600 }, {
      width: 390, height: 350, offsetLeft: 12, offsetTop: 140,
    })).toEqual({ left: 20, top: 148, width: 374, maxHeight: 334 });
  });

  it("keeps a desktop panel next to its anchor unless it hits a viewport edge", () => {
    const viewport = { width: 1280, height: 800, offsetLeft: 0, offsetTop: 0 };
    expect(getAIWritingAssistantLayout({ left: 300, top: 200 }, viewport))
      .toEqual({ left: 300, top: 200, width: 400, maxHeight: 480 });
    expect(getAIWritingAssistantLayout({ left: 1230, top: 790 }, viewport))
      .toEqual({ left: 872, top: 312, width: 400, maxHeight: 480 });
  });

  it("centers a dialog without an editor anchor and fits a short landscape viewport", () => {
    expect(getAIWritingAssistantLayout(undefined, {
      width: 900, height: 300, offsetLeft: 0, offsetTop: 0,
    })).toEqual({ left: 250, top: 8, width: 400, maxHeight: 284 });
  });
});
