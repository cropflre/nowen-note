// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  state: {
    activeNote: null as null | Record<string, unknown>,
    notebooks: [] as Array<Record<string, unknown>>,
  },
  workspace: "personal",
  serverUrl: "https://notes.example.test",
  api: {
    getMe: vi.fn(),
    getNoteSlim: vi.fn(),
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
  getServerUrl: () => mocks.serverUrl,
}));

vi.mock("@/store/AppContext", () => ({
  useApp: () => ({ state: mocks.state }),
  useAppActions: () => mocks.actions,
}));

import OnboardingOpenBridge, { onboardingWelcomeNoteId } from "../OnboardingOpenBridge";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  localStorage.clear();
  mocks.state.activeNote = null;
  mocks.state.notebooks = [];
  mocks.workspace = "personal";
  mocks.serverUrl = "https://notes.example.test";
  vi.clearAllMocks();

  const user = { id: "user-1", username: "new-user" };
  const note = {
    id: onboardingWelcomeNoteId(user.id),
    userId: user.id,
    notebookId: `onboarding-v1-${user.id}-zh`,
    title: "欢迎使用 Nowen Note",
    content: "# 欢迎使用 Nowen Note",
    contentText: "欢迎使用 Nowen Note",
    contentFormat: "markdown",
    version: 1,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  };
  mocks.api.getMe.mockResolvedValue(user);
  mocks.api.getNoteSlim.mockResolvedValue({ id: note.id, version: 1 });
  mocks.api.getNote.mockResolvedValue(note);
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("OnboardingOpenBridge", () => {
  it("opens the seeded Chinese welcome note once and selects its notebook", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);

    try {
      await act(async () => root.render(<OnboardingOpenBridge />));
      await flushEffects();

      const expectedId = onboardingWelcomeNoteId("user-1");
      expect(mocks.api.getNoteSlim).toHaveBeenCalledWith(expectedId);
      expect(mocks.api.getNote).toHaveBeenCalledWith(expectedId);
      expect(mocks.actions.setActiveNote).toHaveBeenCalledWith(
        expect.objectContaining({ id: expectedId, title: "欢迎使用 Nowen Note" }),
      );
      expect(mocks.actions.setSelectedNotebook).toHaveBeenCalledWith(
        "onboarding-v1-user-1-zh",
      );
      expect(mocks.actions.setViewMode).toHaveBeenCalledWith("notebook");
      expect(mocks.actions.setMobileView).toHaveBeenCalledWith("editor");
      expect(mocks.actions.refreshNotebooks).toHaveBeenCalledTimes(1);
      expect(mocks.actions.refreshNotes).toHaveBeenCalledTimes(1);
      expect(
        Object.keys(localStorage).some((key) => key.startsWith("nowen:onboarding-welcome-opened:v1:")),
      ).toBe(true);
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }

    vi.clearAllMocks();
    const secondHost = document.createElement("div");
    document.body.appendChild(secondHost);
    const secondRoot = createRoot(secondHost);
    try {
      await act(async () => secondRoot.render(<OnboardingOpenBridge />));
      await flushEffects();

      expect(mocks.api.getMe).toHaveBeenCalledTimes(1);
      expect(mocks.api.getNoteSlim).not.toHaveBeenCalled();
      expect(mocks.actions.setActiveNote).not.toHaveBeenCalled();
    } finally {
      await act(async () => secondRoot.unmount());
      secondHost.remove();
    }
  });

  it("remembers that old users were not seeded without changing the active note", async () => {
    mocks.api.getNoteSlim.mockRejectedValue(
      Object.assign(new Error("Not found"), { status: 404 }),
    );

    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);

    try {
      await act(async () => root.render(<OnboardingOpenBridge />));
      await flushEffects();

      expect(mocks.actions.setActiveNote).not.toHaveBeenCalled();
      const markerValue = Object.keys(localStorage)
        .map((key) => localStorage.getItem(key))
        .find((value) => value?.includes("not-seeded"));
      expect(markerValue).toBeTruthy();
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("does not interrupt an existing note or a non-personal workspace", async () => {
    mocks.state.activeNote = { id: "already-open" };
    mocks.workspace = "workspace-1";

    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);

    try {
      await act(async () => root.render(<OnboardingOpenBridge />));
      await flushEffects();

      expect(mocks.api.getMe).not.toHaveBeenCalled();
      expect(mocks.actions.setActiveNote).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });
});
