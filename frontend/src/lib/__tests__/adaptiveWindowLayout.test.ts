import { describe, expect, it } from "vitest";
import {
  resolveAdaptiveWindowClass,
  resolveMediumNoteListWidth,
} from "@/lib/adaptiveWindowLayout";

describe("adaptive window layout", () => {
  it("keeps phone and short landscape windows compact", () => {
    expect(resolveAdaptiveWindowClass(412, 915)).toBe("compact");
    expect(resolveAdaptiveWindowClass(680, 479)).toBe("compact");
  });

  it("classifies unfolded phone widths as medium", () => {
    expect(resolveAdaptiveWindowClass(600, 720)).toBe("medium");
    expect(resolveAdaptiveWindowClass(680, 720)).toBe("medium");
    expect(resolveAdaptiveWindowClass(839, 720)).toBe("medium");
  });

  it("uses the expanded workspace from 840px", () => {
    expect(resolveAdaptiveWindowClass(840, 720)).toBe("expanded");
    expect(resolveAdaptiveWindowClass(1280, 800)).toBe("expanded");
  });

  it("keeps the medium note list useful without starving the editor", () => {
    expect(resolveMediumNoteListWidth(600)).toBe(264);
    expect(resolveMediumNoteListWidth(680)).toBe(286);
    expect(resolveMediumNoteListWidth(839)).toBe(320);
  });
});
