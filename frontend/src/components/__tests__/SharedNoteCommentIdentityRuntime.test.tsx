// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  addSharedComment: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: {
    addSharedComment: mocks.addSharedComment,
  },
}));

vi.mock("../SharedNoteView", () => ({
  default: ({ shareToken }: { shareToken: string }) => {
    const [status, setStatus] = React.useState("idle");
    return (
      <button
        type="button"
        data-testid="submit-comment"
        onClick={() => {
          setStatus("pending");
          void import("@/lib/api")
            .then(({ api }) => api.addSharedComment(shareToken, { content: "test" }))
            .then(() => setStatus("done"))
            .catch((error) => setStatus(error?.code || "error"));
        }}
      >
        {status}
      </button>
    );
  },
}));

import SharedNoteCommentIdentityRuntime from "../SharedNoteCommentIdentityRuntime";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const COMMENT = {
  id: "comment-1",
  noteId: "note-1",
  userId: null,
  username: "小王",
  content: "test",
  createdAt: new Date(0).toISOString(),
};

describe("SharedNoteCommentIdentityRuntime", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.clear();
    mocks.addSharedComment.mockReset().mockResolvedValue(COMMENT);
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    document.body.innerHTML = "";
  });

  async function renderRuntime() {
    await act(async () => {
      root.render(<SharedNoteCommentIdentityRuntime shareToken="share-token" />);
    });
  }

  async function submitComment() {
    const button = host.querySelector<HTMLButtonElement>('[data-testid="submit-comment"]');
    expect(button).not.toBeNull();
    await act(async () => {
      button!.click();
      await Promise.resolve();
    });
  }

  async function enterNickname(name: string) {
    const input = document.querySelector<HTMLInputElement>('input[placeholder="例如：小王"]');
    expect(input).not.toBeNull();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set;
      setter?.call(input, name);
      input!.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const confirm = Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes("确认并评论"));
    expect(confirm).not.toBeUndefined();
    await act(async () => {
      confirm!.click();
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it("asks an anonymous visitor for a nickname before the first comment", async () => {
    await renderRuntime();
    await submitComment();

    expect(mocks.addSharedComment).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("发表评论前填写昵称");

    await enterNickname("小王");

    expect(mocks.addSharedComment).toHaveBeenCalledWith(
      "share-token",
      { content: "test", guestName: "小王" },
      undefined,
    );
    expect(localStorage.getItem("nowen-guest-name")).toBe("小王");
    expect(host.textContent).toContain("done");
  });

  it("reuses the nickname stored by an earlier comment", async () => {
    localStorage.setItem("nowen-guest-name", "访客甲");
    await renderRuntime();
    await submitComment();

    expect(document.body.textContent).not.toContain("发表评论前填写昵称");
    expect(mocks.addSharedComment).toHaveBeenCalledWith(
      "share-token",
      { content: "test", guestName: "访客甲" },
      undefined,
    );
    expect(host.textContent).toContain("done");
  });

  it("falls back to the nickname dialog when a stale login token is rejected as a guest", async () => {
    localStorage.setItem("nowen-token", "expired-token");
    mocks.addSharedComment
      .mockRejectedValueOnce(new Error("请填写昵称后再评论"))
      .mockResolvedValueOnce(COMMENT);

    await renderRuntime();
    await submitComment();

    expect(mocks.addSharedComment).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain("发表评论前填写昵称");

    await enterNickname("小李");

    expect(mocks.addSharedComment).toHaveBeenCalledTimes(2);
    expect(mocks.addSharedComment).toHaveBeenLastCalledWith(
      "share-token",
      { content: "test", guestName: "小李" },
      undefined,
    );
    expect(host.textContent).toContain("done");
  });
});
