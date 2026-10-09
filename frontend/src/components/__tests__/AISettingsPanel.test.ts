import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PROVIDER_PRESETS } from "../AISettingsPanel";

describe("AISettingsPanel provider presets", () => {
  it("shows API Key input for custom OpenAI-compatible API", () => {
    const custom = PROVIDER_PRESETS.find(provider => provider.id === "custom");

    expect(custom?.needsKey).toBe(true);
  });

  it("keeps Ollama as a no-key local provider", () => {
    const ollama = PROVIDER_PRESETS.find(provider => provider.id === "ollama");

    expect(ollama?.needsKey).toBe(false);
  });

  it("offers LM Studio as a no-key local or LAN provider", () => {
    const lmstudio = PROVIDER_PRESETS.find(provider => provider.id === "lmstudio");

    expect(lmstudio).toMatchObject({
      url: "http://127.0.0.1:1234/v1",
      needsKey: false,
    });
  });

  it("tests the unsaved draft before saving or activating the profile", () => {
    const source = readFileSync(resolve(process.cwd(), "src/components/AISettingsPanel.tsx"), "utf8");
    const handler = source.slice(source.indexOf("const testConnection = async"), source.indexOf("const activateProfile = async"));
    expect(handler).toContain("aiProfiles.testDraft(draft, selectedId || undefined)");
    expect(handler.indexOf("await aiProfiles.testDraft")).toBeLessThan(handler.indexOf("await persistDraft(true)"));
    expect(handler.indexOf("await persistDraft(true)")).toBeLessThan(handler.indexOf("await aiProfiles.activate"));
    expect(handler).not.toContain("api.testAIConnection()");
  });

  it("offers Embedding settings for a non-chat model instead of testing it", () => {
    const source = readFileSync(resolve(process.cwd(), "src/components/AISettingsPanel.tsx"), "utf8");
    expect(source).toContain("getNonChatModelKind(draft.model)");
    expect(source).toContain("const chatModels = result.models.filter");
    expect(source).toContain('document.querySelector(".nowen-embedding-settings")');
    expect(source).toContain("copy.goToEmbedding");
  });
});
