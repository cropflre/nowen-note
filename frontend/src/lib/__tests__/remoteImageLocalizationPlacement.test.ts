import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function source(relativeUrl: string) {
  return readFileSync(new URL(relativeUrl, import.meta.url), "utf8");
}

describe("remote image localization placement", () => {
  it("lives in Settings data management instead of the task-center corner", () => {
    const taskCenter = source("../../components/TaskCenter.tsx");
    const dataManager = source("../../components/DataManager.tsx");
    const panel = source("../../components/RemoteImageLocalizationPanel.tsx");

    expect(taskCenter).not.toContain("RemoteImageLocalizationPanel");
    expect(dataManager).toContain("<RemoteImageLocalizationPanel />");
    expect(panel).toContain('data-settings-tool="remote-image-localization"');
    expect(panel).toContain("remoteImageLocalization.openTool");
    expect(panel).not.toContain("fixed bottom-5 right-5");
  });
});
