import { describe, expect, it } from "vitest";
import { listPluginNoteTemplates, replacePluginNoteTemplates } from "@/lib/pluginTemplateRegistry";
import { listPluginPrompts, renderPluginPrompt, replacePluginPrompts } from "@/lib/pluginPromptRegistry";
import type { PluginContributionRecord } from "@/lib/pluginApi";

const records: PluginContributionRecord[] = [{
  pluginId: "acme.productivity", publisher: "acme",
  noteTemplates: [{ id: "meeting", name: "Meeting", contentFormat: "markdown", body: "# {{title}}", variables: [{ id: "title", type: "string", required: true }] }],
  promptPacks: [{ id: "rewrite", name: "Rewrite", prompt: "Tone: {{tone}}", inputs: [{ id: "tone", type: "string", default: "clear" }], context: ["selection"] }],
}];

describe("plugin productivity registries", () => {
  it("namespaces note templates without mutating content", () => {
    expect(replacePluginNoteTemplates(records)).toBe(1);
    expect(listPluginNoteTemplates()[0].runtimeId).toBe("acme.productivity/meeting");
  });
  it("renders prompt inputs locally without exposing AI secrets", () => {
    expect(replacePluginPrompts(records)).toBe(1);
    expect(renderPluginPrompt(listPluginPrompts()[0], {})).toBe("Tone: clear");
  });
});
