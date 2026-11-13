import { isNativeClientRuntime } from "./serverUrl";

let ready: Promise<void> | null = null;

/** Restore the normal editor guards before a public web visitor starts editing. */
export function initializeSharedEditorRuntime(): Promise<void> {
  // Native shares still enter through main.tsx, which has already installed these guards.
  if (isNativeClientRuntime()) return Promise.resolve();
  return ready ||= (async () => {
    await import("../i18n");
    const { installCoreRuntime } = await import("./coreRuntimeInstallers");
    installCoreRuntime(
      (source, install) => {
        try { install(); } catch { console.error(`[boot] optional runtime failed: ${source}`); }
      },
      (source) => console.error(`[boot] runtime failed: ${source}`),
    );
    await import("./imageNodeTransformBootstrap");
  })();
}
