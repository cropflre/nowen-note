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

  it("tests the saved profile instead of the disabled effective runtime config", () => {
    const source = readFileSync(resolve(process.cwd(), "src/components/AISettingsPanel.tsx"), "utf8");

    expect(source).toContain("aiProfiles.test(saved.profile.id)");
    expect(source).not.toContain("api.testAIConnection()");
  });
});
