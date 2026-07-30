import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function source(relativeUrl: string) {
  return readFileSync(new URL(relativeUrl, import.meta.url), "utf8");
}

describe("Android image preview tap close contract", () => {
  it("captures a stationary touch on the lightbox image and routes it to close", () => {
    const runtime = source("../../components/TiptapEditorInitializationRuntime.tsx");

    expect(runtime).toContain('const PREVIEW_IMAGE_SELECTOR = \'img[alt="preview"]\'');
    expect(runtime).toContain('document.addEventListener("pointerdown", handlePointerDown, true)');
    expect(runtime).toContain('document.addEventListener("pointerup", handlePointerUp, true)');
    expect(runtime).toContain("Math.hypot(");
    expect(runtime).toContain('querySelector<HTMLButtonElement>(\'button[title="关闭"]\')?.click()');
  });

  it("does not treat desktop mouse input or a moved gesture as a tap", () => {
    const runtime = source("../../components/TiptapEditorInitializationRuntime.tsx");

    expect(runtime).toContain('event.pointerType === "touch"');
    expect(runtime).toContain('event.pointerType === "" && window.matchMedia("(pointer: coarse)").matches');
    expect(runtime).toContain("distance > TAP_MOVE_TOLERANCE_PX");
    expect(runtime).toContain('event.preventDefault()');
  });
});
