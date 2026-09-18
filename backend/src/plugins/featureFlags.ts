import type { ExtensionPlatformFeatureFlags } from "./types.js";

const TRUE_VALUES = new Set(["1", "true", "yes", "on", "enabled"]);

function envFlag(name: string): boolean {
  return TRUE_VALUES.has(String(process.env[name] || "").trim().toLowerCase());
}

/**
 * V2.1 is developed on release/v1.5.0 behind fail-closed gates. The product version stays 1.5.0;
 * plugins that require engines.nowen >=1.6.0 remain incompatible until the actual release version
 * advances. These flags only expose implementation paths for controlled development and tests.
 */
export function getExtensionPlatformFeatureFlags(): Readonly<ExtensionPlatformFeatureFlags> {
  const extensionsV21 = envFlag("NOWEN_EXTENSIONS_V21");
  const uiExtensions = extensionsV21 && envFlag("NOWEN_UI_EXTENSIONS");
  const uiLayoutEditor = uiExtensions && envFlag("NOWEN_UI_LAYOUT_EDITOR");
  const fileProcessingExtensions = extensionsV21 && envFlag("NOWEN_FILE_PROCESSING_EXTENSIONS");
  return Object.freeze({
    extensionsV21,
    pluginStudio: extensionsV21 && envFlag("NOWEN_PLUGIN_STUDIO"),
    uiExtensions,
    uiLayoutEditor,
    sandboxedPluginUi: uiLayoutEditor && envFlag("NOWEN_SANDBOXED_PLUGIN_UI"),
    fileProcessingExtensions,
    experimentalDocumentTypes: fileProcessingExtensions && envFlag("NOWEN_EXPERIMENTAL_DOCUMENT_TYPES"),
  });
}

export function isExtensionV21Enabled(): boolean {
  return getExtensionPlatformFeatureFlags().extensionsV21;
}

export function assertExtensionV21Enabled(capability = "Plugin API V2.1"): void {
  if (!isExtensionV21Enabled()) {
    throw Object.assign(new Error(`${capability} 当前未启用`), { code: "PLUGIN_V21_FEATURE_DISABLED" });
  }
}
