import "./lib/runtimePrelude";
import "./lib/runtimeCompatibility";
import React from "react";
import ReactDOM from "react-dom/client";
import { initializeMobileLocalFirstRuntime } from "./lib/mobileLocalFirstRuntime";
import { initializeDesktopLocalSession } from './lib/desktopLocalSession';
import "./lib/androidCompat";
import "./lib/noteTransferRefreshBridge";
import "./lib/workspaceRefreshBridge";
import "./i18n";
// Must run before App and its import/export/editor schemas are evaluated.
import { ThemeProvider } from "./components/ThemeProvider";
import { SiteSettingsProvider } from "./hooks/useSiteSettings";
import { ConfirmProvider } from "./components/ui/confirm";
import Toaster from "./components/Toaster";
import "./index.css";
import "./editor-list-markers.css";
import "./code-block-wrap.css";
import "./overlay-layers.css";
import "./space-actions.css";
import "./settings-switches.css";
import "./sidebar-search-experience.css";
import "./mobile-knowledge-tree-compact.css";
import "./knowledge-tree-display-size.css";
import "./siyuan-rich-text-callout.css";
import "./knowledge-tree-markdown-drop.css";
import "./inline-comments.css";
import "./loading-experience.css";
import "./note-appearance.css";
import { resolveCurrentAppPathname } from "./lib/appPathNavigation";
import { observeBootSplashReadiness, reportBootStage } from "./lib/bootSplash";

reportBootStage("runtime");

// The image transform schema patch must run before either private or public note
// surfaces evaluate their editor/import schemas, but it must not inflate the login entry.
const loadImageTransformBootstrap = () => import("./lib/imageNodeTransformBootstrap");
const App = React.lazy(async () => {
  await loadImageTransformBootstrap();
  return import("./App");
});
const PublicNotebookView = React.lazy(async () => {
  await loadImageTransformBootstrap();
  return import("./components/PublicNotebookView");
});
const GlobalBridges = React.lazy(() => import("./components/GlobalBridges"));

function reportBootError(source: string, error: unknown, fatal: boolean): void {
  try {
    const reporter = (window as Window & { __NOWEN_REPORT_BOOT_ERROR__?: (source: string, error: unknown, fatal: boolean) => void }).__NOWEN_REPORT_BOOT_ERROR__;
    if (typeof reporter === "function") reporter(source, error, fatal);
  } catch {
    /* diagnostics must never become another startup failure */
  }
}

function installOptionalRuntime(source: string, install: () => unknown): void {
  try {
    install();
  } catch (error) {
    console.error(`[boot] optional runtime failed: ${source}`, error);
    reportBootError(source, error, false);
  }
}

class ApplicationBootErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    reportBootError("react-render", error, true);
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}


/**
 * The HTML startup card stays above React while lazy modules, auth restoration and quick
 * login probing are running. Once a real route or interactive surface mounts, this observer
 * dismisses it with the minimum-visible-time guard from bootSplash.ts.
 */
function BootSplashReadinessObserver() {
  React.useEffect(() => observeBootSplashReadiness(document.getElementById("root")), []);
  return null;
}

/**
 * Suspense must stay visually silent during cold start. The HTML startup card already owns
 * that feedback; rendering another centered spinner here caused the second loading screen.
 */
function MainRouteFallback() {
  return null;
}


const THEME_KEY = "nowen-note-theme";
try {
  if (typeof localStorage !== "undefined" && !localStorage.getItem(THEME_KEY)) {
    localStorage.setItem(THEME_KEY, "light");
  }
} catch (error) {
  reportBootError("theme-storage", error, false);
}

try {
  const desk: any = (window as any).nowenDesktop;
  if (desk && desk.isDesktop && typeof desk.platform === "string") {
    document.documentElement.setAttribute("data-electron", desk.platform);
  }
} catch {
  /* 纯 Web 环境：静默 */
}

function resolvePublicNotebookRoute(): { matched: boolean; token?: string } {
  const match = resolveCurrentAppPathname().match(/^\/public(?:\/([^/]+))?\/?$/);
  if (!match) return { matched: false };
  if (!match[1]) return { matched: true };
  try {
    return { matched: true, token: decodeURIComponent(match[1]) };
  } catch {
    return { matched: true, token: match[1] };
  }
}

const publicRoute = resolvePublicNotebookRoute();

let applicationRendered = false;

function renderApplication() {
  if (applicationRendered) return;
  reportBootStage("rendering");
  applicationRendered = true;
  try {
    const root = document.getElementById("root");
    if (!root) throw new Error("Missing #root mount element");
    ReactDOM.createRoot(root).render(
      <ApplicationBootErrorBoundary>
      <React.StrictMode>
    <SiteSettingsProvider>
      <ConfirmProvider>
        <BootSplashReadinessObserver />
        {publicRoute.matched ? (
          <ThemeProvider>
            <React.Suspense fallback={<MainRouteFallback />}>
              <PublicNotebookView token={publicRoute.token} />
            </React.Suspense>
            <Toaster />
          </ThemeProvider>
        ) : (
          <>
            <React.Suspense fallback={null}>
              <GlobalBridges />
            </React.Suspense>
            <React.Suspense fallback={<MainRouteFallback />}>
              <App />
            </React.Suspense>
          </>
        )}
      </ConfirmProvider>
    </SiteSettingsProvider>
      </React.StrictMode>
      </ApplicationBootErrorBoundary>,
    );
  } catch (error) {
    applicationRendered = false;
    reportBootError("react-root", error, true);
  }
}

let coreRuntimeInstalled = false;
Promise.resolve()
  .then(() => import("./lib/coreRuntimeInstallers"))
  .then(({ installCoreRuntime }) => {
    installCoreRuntime(installOptionalRuntime, reportBootError);
    coreRuntimeInstalled = true;
  })
  .then(() => initializeDesktopLocalSession().catch(error => reportBootError('desktop-local-session',error,false)))
  .then(() => initializeMobileLocalFirstRuntime())
  .then(
    () => renderApplication(),
    (error) => {
      // Native local-first initialization is an enhancement. A rejected or unsupported
      // native bridge must never prevent Web/WKWebView users from reaching login/workspace.
      if (!coreRuntimeInstalled) {
        // Required network and persistence guards were not installed; never
        // expose an editor that might write without those protections.
        reportBootError("core-runtime-install", error, true);
        return;
      }
      reportBootError("mobile-local-first", error, false);
      renderApplication();
    },
  );
