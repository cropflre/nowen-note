import { createRoot } from "react-dom/client";
import AIMemoryHub from "../src/components/AIMemoryHub";
import { getOfflineQueueStorageKey } from "../src/lib/offlineScope";
import i18n from "../src/i18n";
import "../src/index.css";

// This harness uses only the disposable account supplied by the acceptance runner.
// It does not seed or read a user's existing Nowen configuration.
// The product derives its reverse-proxy API prefix from the app URL.
window.history.replaceState(null, "", "/");
void i18n.changeLanguage("zh-CN");
createRoot(document.getElementById("root")!).render(
  <main className="min-h-screen bg-surface p-2 text-text sm:p-6">
    <AIMemoryHub scope={getOfflineQueueStorageKey()} />
  </main>,
);
