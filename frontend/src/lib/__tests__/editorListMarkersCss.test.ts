import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync("src/editor-list-markers.css", "utf8");
const main = readFileSync("src/main.tsx", "utf8");

describe("editor list marker compatibility CSS", () => {
  it("suppresses ordinary bullets for Tiptap task NodeViews", () => {
    expect(css).toContain("ul > li.task-item::before");
    expect(css).toContain("content: none !important");
  });

  it("excludes every supported task item identity from ordinary markers", () => {
    expect(css).toContain(':not([data-type="taskItem"]):not(.task-item):not(.task-list-item)::before');
  });

  it("centers marker glyphs in a stable box with first-line compensation", () => {
    expect(css).toContain("left: -1.25em");
    expect(css).toContain("width: 1em");
    expect(css).toContain("text-align: center");
    expect(css).toContain("--nowen-ul-marker-top: 0.3em");
    expect(css).toContain("--nowen-ul-marker-top: 0.25em");
  });

  it("does not mutate ProseMirror task NodeViews from a global observer", () => {
    expect(main).not.toContain("taskListNodeViewIdentity");
    expect(main).not.toContain("installTaskListNodeViewIdentity");
  });
});