import "./lib/runtimePrelude";
import { resolveCurrentAppPathname } from "./lib/appPathNavigation";
import { isNativeClientRuntime } from "./lib/serverUrl";

// Public web shares have no workspace to restore or background sync to start.
const shareMatch = !isNativeClientRuntime()
  && resolveCurrentAppPathname().match(/^\/share\/([A-Za-z0-9_-]+)$/);

if (shareMatch) {
  void import("./sharedPage").then(({ renderSharedPage }) => renderSharedPage(shareMatch[1]));
} else {
  void import("./main");
}
