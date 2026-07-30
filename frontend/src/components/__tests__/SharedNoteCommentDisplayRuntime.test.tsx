// @vitest-environment jsdom

import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ShareComment } from "@/types";

const mocks = vi.hoisted(() => ({
  getSharedComments: vi.fn(),
  addSharedComment: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: {
    getSharedComments: mocks.getSharedComments,
    addSharedComment: mocks.addSharedComment,
  },
}));

vi.mock("../SharedNoteCommentIdentityRuntime", () => ({
  default: ({ shareToken }: { shareToken: string }) => (
    <div data-testid="identity-runtime">{shareToken}</div>
  ),
}));

import { api } from "@/lib/api";
import SharedNoteCommentDisplayRuntime, {
  normalizeSharedCommentDisplayName,
} from "../SharedNoteCommentDisplayRuntime";

const NOW = new Date(0).toISOString();
const BASE_COMMENT: ShareComment = {
  id: "comment-1",
  noteId: "note-1",
  userId: null,
  displayName: undefined,
  isGuest: true,
  guestName: null,
  username: null,
  avatarUrl: null,
  parentId: null,
  content: "test",
  anchorData: null,
  isResolved: 0,
  createdAt: NOW,
  updatedAt: NOW,
};

describe("SharedNoteCommentDisplayRuntime", () => {
  beforeEach(() => {
    mocks.getSharedComments.mockReset();
    mocks.addSharedComment.mockReset();
  });

  it("projects displayName into username for existing public comments", async () => {
    mocks.getSharedComments.mockResolvedValue([
      {
        ...BASE_COMMENT,
        guestName: "访客甲",
        displayName: "访客甲",
      },
    ]);

    const comments = await api.getSharedComments("share-token");

    expect(comments[0].username).toBe("访客甲");
    expect(comments[0].displayName).toBe("访客甲");
  });

  it("projects the nickname immediately after an anonymous comment is added", async () => {
    mocks.addSharedComment.mockResolvedValue({
      ...BASE_COMMENT,
      guestName: "访客乙",
      displayName: "访客乙",
    });

    const comment = await api.addSharedComment(
      "share-token",
      { content: "test", guestName: "访客乙" },
    );

    expect(comment.username).toBe("访客乙");
    expect(comment.displayName).toBe("访客乙");
  });

  it("falls back from displayName to guestName and finally 匿名", () => {
    expect(normalizeSharedCommentDisplayName({
      ...BASE_COMMENT,
      guestName: " 小王 ",
    }).username).toBe("小王");
    expect(normalizeSharedCommentDisplayName(BASE_COMMENT).username).toBe("匿名");
  });

  it("keeps the identity runtime mounted", () => {
    const element = SharedNoteCommentDisplayRuntime({ shareToken: "share-token" });
    expect(element.props.shareToken).toBe("share-token");
  });
});
