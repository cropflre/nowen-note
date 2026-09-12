import assert from "node:assert/strict";
import test from "node:test";
import { getExtensionPlatformFeatureFlags } from "../src/plugins/featureFlags";
import { EXTENSION_V21_TARGET_NOWEN_VERSION, NOWEN_VERSION } from "../src/plugins/types";

const KEYS = [
  "NOWEN_EXTENSIONS_V21",
  "NOWEN_PLUGIN_STUDIO",
  "NOWEN_FILE_PROCESSING_EXTENSIONS",
  "NOWEN_EXPERIMENTAL_DOCUMENT_TYPES",
] as const;

function withEnv(values: Partial<Record<typeof KEYS[number], string>>, run: () => void): void {
  const previous = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  try {
    for (const key of KEYS) delete process.env[key];
    for (const [key, value] of Object.entries(values)) process.env[key] = value;
    run();
  } finally {
    for (const key of KEYS) {
      const value = previous[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("V2.1 feature gates fail closed by default", () => {
  withEnv({}, () => assert.deepEqual(getExtensionPlatformFeatureFlags(), {
    extensionsV21: false,
    pluginStudio: false,
    fileProcessingExtensions: false,
    experimentalDocumentTypes: false,
  }));
});

test("dependent V2.1 gates cannot bypass their parent capability", () => {
  withEnv({ NOWEN_PLUGIN_STUDIO: "true", NOWEN_FILE_PROCESSING_EXTENSIONS: "true", NOWEN_EXPERIMENTAL_DOCUMENT_TYPES: "true" }, () => {
    assert.deepEqual(getExtensionPlatformFeatureFlags(), {
      extensionsV21: false,
      pluginStudio: false,
      fileProcessingExtensions: false,
      experimentalDocumentTypes: false,
    });
  });
  withEnv({ NOWEN_EXTENSIONS_V21: "1", NOWEN_PLUGIN_STUDIO: "yes", NOWEN_FILE_PROCESSING_EXTENSIONS: "on", NOWEN_EXPERIMENTAL_DOCUMENT_TYPES: "enabled" }, () => {
    assert.deepEqual(getExtensionPlatformFeatureFlags(), {
      extensionsV21: true,
      pluginStudio: true,
      fileProcessingExtensions: true,
      experimentalDocumentTypes: true,
    });
  });
});

test("development branch does not impersonate the V2.1 release version", () => {
  assert.equal(NOWEN_VERSION, "1.5.0");
  assert.equal(EXTENSION_V21_TARGET_NOWEN_VERSION, "1.6.0");
});
