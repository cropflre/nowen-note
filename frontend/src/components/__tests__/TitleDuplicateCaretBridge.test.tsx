import { afterEach, describe, expect, it } from "vitest";
import { syncTitleDuplicateCaretProxy } from "@/components/TitleDuplicateCaretBridge";

describe("TitleDuplicateCaretBridge", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  function setup() {
    document.body.innerHTML = `
      <input id="title" value="abcdef" style="caret-color: rgb(15, 23, 42)">
      <div data-title-duplicate-mirror>
        <div><span class="text-red-500">abc</span><span>def</span></div>
      </div>
    `;
    const field = document.querySelector<HTMLInputElement>("#title")!;
    field.focus();
    return field;
  }

  it("draws the visual caret at the real selection position inside the duplicate prefix", () => {
    const field = setup();
    field.setSelectionRange(2, 2);

    expect(syncTitleDuplicateCaretProxy()).toBe(true);
    const prefix = document.querySelector<HTMLSpanElement>("[data-title-duplicate-mirror] div > span:first-child")!;
    const caret = prefix.querySelector<HTMLElement>("[data-nowen-title-duplicate-caret]");

    expect(caret).not.toBeNull();
    expect(prefix.textContent).toBe("abc");
    expect(document.querySelector("[data-title-duplicate-mirror] div")?.textContent).toBe("abcdef");
  });

  it("moves the visual caret into the normal-color suffix on a second click/selection change", () => {
    const field = setup();
    field.setSelectionRange(5, 5);

    expect(syncTitleDuplicateCaretProxy()).toBe(true);
    const suffix = document.querySelector<HTMLSpanElement>("[data-title-duplicate-mirror] div > span:last-child")!;

    expect(suffix.querySelector("[data-nowen-title-duplicate-caret]")).not.toBeNull();
    expect(document.querySelector("[data-title-duplicate-mirror] div")?.textContent).toBe("abcdef");
  });

  it("does not draw a proxy caret while a title range is selected", () => {
    const field = setup();
    field.setSelectionRange(1, 4);

    expect(syncTitleDuplicateCaretProxy()).toBe(false);
    expect(document.querySelector("[data-nowen-title-duplicate-caret]")).toBeNull();
  });

  it("places the caret within the third segment of a multi-range mirror", () => {
    document.body.innerHTML = `
      <input id="title" value="aa123456bb" style="caret-color: rgb(15, 23, 42)">
      <div data-title-duplicate-mirror><div>
        <span>aa</span><span class="text-red-500">123456</span><span>bb</span>
      </div></div>
    `;
    const field = document.querySelector<HTMLInputElement>("#title")!;
    field.focus();
    field.setSelectionRange(9, 9);
    expect(syncTitleDuplicateCaretProxy()).toBe(true);
    const spans = document.querySelectorAll("[data-title-duplicate-mirror] div > span");
    expect(spans[2].querySelector("[data-nowen-title-duplicate-caret]")).not.toBeNull();
    expect(Array.from(spans).map((span) => span.textContent).join("")).toBe(field.value);
  });
});
