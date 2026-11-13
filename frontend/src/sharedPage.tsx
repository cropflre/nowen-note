import "./lib/runtimeCompatibility";
import "./lib/androidCompat";
import React from "react";
import { createRoot } from "react-dom/client";
import { MotionConfig } from "framer-motion";
import { ThemeProvider } from "./components/ThemeProvider";
import { SiteSettingsProvider } from "./hooks/useSiteSettings";
import { ConfirmProvider } from "./components/ui/confirm";
import Toaster from "./components/Toaster";
import SharedNoteView from "./components/SharedNoteCommentDisplayRuntime";
import WebUiDisabledPage from "./components/WebUiDisabledPage";
import { fetchWebUiEnabled } from "./lib/webUiAccess";
import { dismissBootSplash, observeBootSplashReadiness, reportBootStage } from "./lib/bootSplash";
import { initCodeBlockTheme } from "./lib/codeBlockTheme";
import "./index.css";
import "./editor-list-markers.css";
import "./code-block-wrap.css";
import "./siyuan-rich-text-callout.css";
import "./note-appearance.css";
import "./overlay-layers.css";
import "./motion.css";

function SharedPageReadinessObserver() {
  React.useEffect(() => observeBootSplashReadiness(document.getElementById("root")), []);
  return null;
}

class SharedPageErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch() { dismissBootSplash(); }
  render() {
    return this.state.failed
      ? <div role="alert" className="p-8 text-tx-primary">分享页面加载失败，请刷新重试。</div>
      : this.props.children;
  }
}

export async function renderSharedPage(shareToken: string): Promise<void> {
  const webUiAllowed = await fetchWebUiEnabled();
  reportBootStage("rendering");
  initCodeBlockTheme();
  createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <SharedPageErrorBoundary>
        <SharedPageReadinessObserver />
        {webUiAllowed ? (
          <MotionConfig reducedMotion="user">
            <SiteSettingsProvider>
              <ConfirmProvider>
                <ThemeProvider>
                  <SharedNoteView shareToken={shareToken} />
                  <Toaster />
                </ThemeProvider>
              </ConfirmProvider>
            </SiteSettingsProvider>
          </MotionConfig>
        ) : <WebUiDisabledPage />}
      </SharedPageErrorBoundary>
    </React.StrictMode>,
  );
}
