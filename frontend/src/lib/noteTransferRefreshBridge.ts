import { getCurrentWorkspace } from "@/lib/api.impl";

const INSTALL_KEY = "__NOWEN_NOTE_TRANSFER_REFRESH_BRIDGE__" as const;

type BridgeWindow = Window & typeof globalThis & {
  [INSTALL_KEY]?: () => void;
};

/**
 * The transfer dialog lives outside AppContext so it can be opened on desktop and
 * mobile without threading selection state through the whole shell. After a
 * successful transfer, ask the existing workspace reload path to refresh the
 * active note/notebook lists and close stale open tabs if a moved note vanished.
 */
export function installNoteTransferRefreshBridge(): void {
  if (typeof window === "undefined") return;
  const bridgeWindow = window as BridgeWindow;
  if (bridgeWindow[INSTALL_KEY]) return;

  const onComplete = () => {
    const workspaceId = getCurrentWorkspace();
    window.requestAnimationFrame(() => {
      window.dispatchEvent(new CustomEvent("nowen:workspace-changed", {
        detail: { workspaceId, reason: "note-transfer" },
      }));
    });
  };

  window.addEventListener("nowen:note-transfer-complete", onComplete);
  bridgeWindow[INSTALL_KEY] = () => {
    window.removeEventListener("nowen:note-transfer-complete", onComplete);
    delete bridgeWindow[INSTALL_KEY];
  };
}

installNoteTransferRefreshBridge();
