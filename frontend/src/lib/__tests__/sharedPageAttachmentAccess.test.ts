import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  order: [] as string[],
  webUiAllowed: true,
  captureUpstream: vi.fn(),
  installBridge: vi.fn(),
  renderRoot: vi.fn(),
  createRoot: vi.fn(),
}));

mocks.captureUpstream.mockImplementation(() => { mocks.order.push("capture-upstream"); });
mocks.installBridge.mockImplementation(() => { mocks.order.push("install-bridge"); });
mocks.renderRoot.mockImplementation(() => { mocks.order.push("render-root"); });
mocks.createRoot.mockImplementation(() => ({ render: mocks.renderRoot }));

vi.mock("react-dom/client", () => ({ createRoot: mocks.createRoot }));
vi.mock("../../lib/runtimeCompatibility", () => ({}));
vi.mock("../../lib/androidCompat", () => ({}));
vi.mock("../../components/ThemeProvider", () => ({ ThemeProvider: ({ children }: { children: unknown }) => children }));
vi.mock("../../hooks/useSiteSettings", () => ({ SiteSettingsProvider: ({ children }: { children: unknown }) => children }));
vi.mock("../../components/ui/confirm", () => ({ ConfirmProvider: ({ children }: { children: unknown }) => children }));
vi.mock("../../components/Toaster", () => ({ default: () => null }));
vi.mock("../../components/SharedNoteCommentDisplayRuntime", () => ({ default: () => null }));
vi.mock("../../components/WebUiDisabledPage", () => ({ default: () => null }));
vi.mock("../../lib/webUiAccess", () => ({ fetchWebUiEnabled: vi.fn(async () => mocks.webUiAllowed) }));
vi.mock("../../lib/bootSplash", () => ({
  dismissBootSplash: vi.fn(),
  observeBootSplashReadiness: vi.fn(() => () => {}),
  reportBootStage: vi.fn(),
}));
vi.mock("../../lib/codeBlockTheme", () => ({ initCodeBlockTheme: vi.fn() }));
vi.mock("../../lib/attachmentAccessUpstreamFetch", () => ({
  captureAttachmentAccessUpstreamFetch: mocks.captureUpstream,
}));
vi.mock("../../lib/noteAttachmentAccessBridge", () => ({
  installNoteAttachmentAccessBridge: mocks.installBridge,
}));

describe("shared page attachment access bootstrap", () => {
  beforeEach(() => {
    mocks.order.length = 0;
    mocks.webUiAllowed = true;
    vi.clearAllMocks();
    document.body.innerHTML = '<div id="root"></div>';
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("installs the attachment access bridge before rendering a public share (DCC-006)", async () => {
    const { renderSharedPage } = await import("../../sharedPage");
    await renderSharedPage("share-token-123");

    expect(mocks.captureUpstream).toHaveBeenCalledOnce();
    expect(mocks.installBridge).toHaveBeenCalledOnce();
    expect(mocks.renderRoot).toHaveBeenCalledOnce();
    expect(mocks.order).toEqual(["capture-upstream", "install-bridge", "render-root"]);
  });

  it("skips installing the attachment access bridge when Web UI is disabled", async () => {
    mocks.webUiAllowed = false;
    const { renderSharedPage } = await import("../../sharedPage");
    await renderSharedPage("share-token-123");

    expect(mocks.captureUpstream).not.toHaveBeenCalled();
    expect(mocks.installBridge).not.toHaveBeenCalled();
    expect(mocks.renderRoot).toHaveBeenCalledOnce();
  });
});
