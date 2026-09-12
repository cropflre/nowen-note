import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const readSource = (relativeUrl: string) => readFileSync(new URL(relativeUrl, import.meta.url), "utf8");

describe("note appearance provider boundary", () => {
  it("does not mount NoteAppearanceBridge from the root entry outside AppProvider", () => {
    const mainSource = readSource("../../main.tsx");
    expect(mainSource).not.toContain("<NoteAppearanceBridge");
    expect(mainSource).not.toContain('from "./components/NoteAppearanceBridge"');
  });

  it("mounts NoteAppearanceBridge through a provider-local runtime bridge", () => {
    const appSource = readSource("../../App.tsx");
    const bridgeHostSource = readSource("../../components/SidebarSearchExperienceBridge.tsx");

    const providerIndex = appSource.indexOf("<AppProvider>");
    const hostIndex = appSource.indexOf("<SidebarSearchExperienceBridge />");

    expect(providerIndex).toBeGreaterThanOrEqual(0);
    expect(hostIndex).toBeGreaterThan(providerIndex);
    expect(bridgeHostSource).toContain('import NoteAppearanceBridge from "@/components/NoteAppearanceBridge"');
    expect(bridgeHostSource).toContain("<NoteAppearanceBridge />");
  });

  it("binds themes to each note surface independently, including split view", () => {
    const bridgeSource = readSource("../../components/NoteAppearanceBridge.tsx");
    const editorSource = readSource("../../components/EditorPane.tsx");
    const splitSource = readSource("../../components/EditorSplitView.tsx");

    expect(bridgeSource).toContain("surface.dataset.noteId");
    expect(editorSource).toContain("data-note-id={activeNote.id}");
    expect(splitSource).toContain("data-note-id={note?.id ?? noteId}");
  });
});
