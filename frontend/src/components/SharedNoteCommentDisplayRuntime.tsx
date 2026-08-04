import React from "react";

import SharedNoteCommentIdentityRuntime from "./SharedNoteCommentIdentityRuntime";
import { api } from "@/lib/api";
import { normalizeShareCommentTimestamp } from "@/lib/shareCommentTime";
import type { ShareComment } from "@/types";

const COMMENT_DISPLAY_STATE_KEY = "__nowenSharedCommentDisplayRuntime__" as const;
const COMMENT_DISPLAY_RUNTIME_VERSION = 2;

type GetSharedComments = typeof api.getSharedComments;
type AddSharedComment = typeof api.addSharedComment;

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
 *
 * The same boundary also canonicalizes SQLite's timezone-less UTC `createdAt` value to an
 * explicit ISO timestamp, so all existing SharedNoteView date rendering uses the viewer's
 * local timezone correctly.
 */
export function normalizeSharedCommentDisplayName(comment: ShareComment): ShareComment {
  const normalizedComment = normalizeShareCommentTimestamp(comment);
  const displayName = [
    normalizedComment.displayName,
    normalizedComment.guestName,
    normalizedComment.username,
  ]
    .find((value) => typeof value === "string" && value.trim())
    ?.trim() || "匿名";

  if (
    normalizedComment.username === displayName &&
    normalizedComment.displayName === displayName
  ) return normalizedComment;

  return {
    ...normalizedComment,
    username: displayName,
    displayName,
  };
}

function installCommentDisplayBridge(): void {
  const state = getCommentDisplayRuntimeState();
  if (state.version >= COMMENT_DISPLAY_RUNTIME_VERSION) return;

  state.nativeGetSharedComments = state.nativeGetSharedComments || api.getSharedComments.bind(api);
  state.nativeAddSharedComment = state.nativeAddSharedComment || api.addSharedComment.bind(api);

  const nativeGetSharedComments = state.nativeGetSharedComments;
  const nativeAddSharedComment = state.nativeAddSharedComment;

  api.getSharedComments = async (...args: Parameters<GetSharedComments>) => {
    const comments = await nativeGetSharedComments(...args);
    return comments.map(normalizeSharedCommentDisplayName);
  };

  api.addSharedComment = async (...args: Parameters<AddSharedComment>) => {
    const comment = await nativeAddSharedComment(...args);
    return normalizeSharedCommentDisplayName(comment);
  };

  state.version = COMMENT_DISPLAY_RUNTIME_VERSION;
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
