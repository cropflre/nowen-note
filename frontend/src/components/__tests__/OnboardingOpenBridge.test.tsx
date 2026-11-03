// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  state: { activeNote: null as null | { id: string } },
  workspace: "personal",
  scope: "server:account",
  api: {
    claimOnboardingWelcome: vi.fn(),
    getNote: vi.fn(),
  },
  actions: {
    setActiveNote: vi.fn(),
    setSelectedNotebook: vi.fn(),
    setViewMode: vi.fn(),
    setMobileView: vi.fn(),
    refreshNotebooks: vi.fn(),
    refreshNotes: vi.fn(),
  },
}));

vi.mock("@/lib/api", () => ({
  api: mocks.api,
  getCurrentWorkspace: () => mocks.workspace,
}));
vi.mock("@/lib/offlineScope", () => ({
  getOfflineQueueStorageKey: () => mocks.scope,
}));
vi.mock("@/store/AppContext", () => ({
  useApp: () => ({ state: mocks.state }),
  useAppActions: () => mocks.actions,
}));

import OnboardingOpenBridge from "../OnboardingOpenBridge";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const note = {
  id: "onboarding-v1-user-1-zh-welcome",
  userId: "user-1",
  notebookId: "onboarding-v1-user-1-zh",
  title: "欢迎使用 Nowen Note",
};

async function mountBridge(): Promise<() => Promise<void>> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(<React.StrictMode><OnboardingOpenBridge /></React.StrictMode>));
  return async () => {
    await act(async () => root.unmount());
    host.remove();
  };
}

beforeEach(() => {
  localStorage.clear();
  mocks.state.activeNote = null;
  mocks.workspace = "personal";
  mocks.scope = "server:account";
  vi.resetAllMocks();
  mocks.api.getNote.mockResolvedValue(note);
});

describe("OnboardingOpenBridge", () => {
  it("opens a server-granted welcome once and does not reopen after a storage clear or URL change", async () => {
    mocks.api.claimOnboardingWelcome
      .mockResolvedValueOnce({ noteId: note.id })
      .mockResolvedValue({ noteId: null });

    const unmount = await mountBridge();
    try {
      expect(mocks.api.claimOnboardingWelcome).toHaveBeenCalledTimes(1);
      expect(mocks.api.getNote).toHaveBeenCalledWith(note.id);
      expect(mocks.actions.setActiveNote).toHaveBeenCalledWith(note);
      expect(mocks.actions.setSelectedNotebook).toHaveBeenCalledWith(note.notebookId);
      expect(mocks.actions.setViewMode).toHaveBeenCalledWith("notebook");
      expect(mocks.actions.setMobileView).toHaveBeenCalledWith("editor");
      expect(mocks.actions.refreshNotebooks).toHaveBeenCalledTimes(1);
      expect(mocks.actions.refreshNotes).toHaveBeenCalledTimes(1);
    } finally {
      await unmount();
    }

    vi.clearAllMocks();
    localStorage.clear();
    mocks.scope = "server-alias:account";
    const unmountAlias = await mountBridge();
    try {
      expect(mocks.api.claimOnboardingWelcome).toHaveBeenCalledTimes(1);
      expect(mocks.api.getNote).not.toHaveBeenCalled();
      expect(mocks.actions.setActiveNote).not.toHaveBeenCalled();
    } finally {
      await unmountAlias();
    }
  });

  it("does not open the welcome when the server lacks account-level support", async () => {
    mocks.api.claimOnboardingWelcome.mockRejectedValue(
      Object.assign(new Error("Not found"), { status: 404 }),
    );
    const unmount = await mountBridge();
    try {
      expect(mocks.api.getNote).not.toHaveBeenCalled();
      expect(mocks.actions.setActiveNote).not.toHaveBeenCalled();
    } finally {
      await unmount();
    }
  });

  it("does not interrupt an existing note or a non-personal workspace", async () => {
    mocks.state.activeNote = { id: "already-open" };
    mocks.workspace = "workspace-1";
    const unmount = await mountBridge();
    try {
      expect(mocks.api.claimOnboardingWelcome).not.toHaveBeenCalled();
      expect(mocks.actions.setActiveNote).not.toHaveBeenCalled();
    } finally {
      await unmount();
    }
  });

  it("ignores a welcome response after switching account", async () => {
    mocks.api.claimOnboardingWelcome.mockImplementation(async () => {
      mocks.scope = "server:other-account";
      return { noteId: note.id };
    });
    const unmount = await mountBridge();
    try {
      expect(mocks.api.getNote).not.toHaveBeenCalled();
      expect(mocks.actions.setActiveNote).not.toHaveBeenCalled();
    } finally {
      await unmount();
    }
  });
});
