import React from "react";

import SharedNoteCommentIdentityRuntime from "./SharedNoteCommentIdentityRuntime";
import { api } from "@/lib/api";

const COMMENT_DISPLAY_STATE_KEY = "__nowenSharedCommentDisplayRuntime__" as const;

type GetSharedComments = typeof api.getSharedComments;
type AddSharedComment = typeof api.addSharedComment;

type SharedCommentIdentityFields = {
  username?: string | null;
  displayName?: string | null;
  guestName?: string | null;
  [key: string]: unknown;
};

interface CommentDisplayRuntimeState {
  version: number;
  nativeGetSharedComments: GetSharedComments | null;
  nativeAddSharedComment: AddSharedComment | null;
}

function getCommentDisplayRuntimeState(): CommentDisplayRuntimeState {
  const globalStore = globalThis as typeof globalThis & {
    __nowenSharedCommentDisplayRuntime__?: CommentDisplayRuntimeState;
  };
  if (!globalStore[COMMENT_DISPLAY_STATE_KEY]) {
    globalStore[COMMENT_DISPLAY_STATE_KEY] = {
      version: 0,
      nativeGetSharedComments: null,
      nativeAddSharedComment: null,
    };
  }
  return globalStore[COMMENT_DISPLAY_STATE_KEY]!;
}

/**
 * SharedNoteView still renders `comment.username`, while the public comment API deliberately
 * returns anonymous visitor identity through `displayName` / `guestName`. Project the public
 * identity into the legacy field at the runtime boundary so both existing and newly-added
 * comments render the nickname without changing the management-side comment contract.
 */
export function normalizeSharedCommentDisplayName<T extends SharedCommentIdentityFields>(comment: T): T {
  const displayName = [comment.displayName, comment.guestName, comment.username]
    .find((value) => typeof value === "string" && value.trim())
    ?.trim() || "匿名";

  if (comment.username === displayName && comment.displayName === displayName) return comment;
  return {
    ...comment,
    username: displayName,
    displayName,
  } as T;
}

function installCommentDisplayBridge(): void {
  const state = getCommentDisplayRuntimeState();
  if (state.version >= 1) return;

  state.nativeGetSharedComments = state.nativeGetSharedComments || api.getSharedComments.bind(api);
  state.nativeAddSharedComment = state.nativeAddSharedComment || api.addSharedComment.bind(api);

  const nativeGetSharedComments = state.nativeGetSharedComments;
  const nativeAddSharedComment = state.nativeAddSharedComment;

  api.getSharedComments = (async (...args: Parameters<GetSharedComments>) => {
    const comments = await nativeGetSharedComments(...args);
    return comments.map((comment) => normalizeSharedCommentDisplayName(comment));
  }) as GetSharedComments;

  api.addSharedComment = (async (...args: Parameters<AddSharedComment>) => {
    const comment = await nativeAddSharedComment(...args);
    return normalizeSharedCommentDisplayName(comment);
  }) as AddSharedComment;

  state.version = 1;
}

installCommentDisplayBridge();

interface SharedNoteCommentDisplayRuntimeProps {
  shareToken: string;
}

export default function SharedNoteCommentDisplayRuntime({
  shareToken,
}: SharedNoteCommentDisplayRuntimeProps) {
  return <SharedNoteCommentIdentityRuntime shareToken={shareToken} />;
}
