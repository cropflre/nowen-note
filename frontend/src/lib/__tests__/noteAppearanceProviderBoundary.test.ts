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
});
