import React, { useCallback, useEffect, useRef, useState } from "react";
import { UserCircle2 } from "lucide-react";

import SharedNoteView from "./SharedNoteView";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";

const GUEST_NAME_KEY = "nowen-guest-name";
const COMMENT_IDENTITY_STATE_KEY = "__nowenSharedCommentIdentityRuntime__" as const;

type AddSharedComment = typeof api.addSharedComment;
type AddSharedCommentArgs = Parameters<AddSharedComment>;
type GuestNameRequester = () => Promise<string | null>;

interface CommentIdentityRuntimeState {
  requester: GuestNameRequester | null;
  patched: boolean;
  nativeAddSharedComment: AddSharedComment | null;
}

function getCommentIdentityRuntimeState(): CommentIdentityRuntimeState {
  const globalStore = globalThis as typeof globalThis & {
    __nowenSharedCommentIdentityRuntime__?: CommentIdentityRuntimeState;
  };
  if (!globalStore[COMMENT_IDENTITY_STATE_KEY]) {
    globalStore[COMMENT_IDENTITY_STATE_KEY] = {
      requester: null,
      patched: false,
      nativeAddSharedComment: null,
    };
  }
  return globalStore[COMMENT_IDENTITY_STATE_KEY]!;
}

function readStoredGuestName(): string {
  try {
    return localStorage.getItem(GUEST_NAME_KEY)?.trim() || "";
  } catch {
    return "";
  }
}

function hasAuthToken(): boolean {
  try {
    return Boolean(localStorage.getItem("nowen-token"));
  } catch {
    return false;
  }
}

export function isGuestNameRequiredError(error: unknown): boolean {
  const candidate = error as { code?: string; message?: string } | null;
  return candidate?.code === "GUEST_NAME_REQUIRED"
    || /填写昵称.*评论|昵称后再评论/.test(candidate?.message || "");
}

function createCancelledCommentError(): Error & { code: string } {
  const error = new Error("评论已取消") as Error & { code: string };
  error.code = "COMMENT_CANCELLED";
  return error;
}

function installCommentIdentityBridge(): void {
  const runtime = getCommentIdentityRuntimeState();
  if (runtime.patched) return;

  runtime.patched = true;
  runtime.nativeAddSharedComment = api.addSharedComment.bind(api);

  api.addSharedComment = (async (...args: AddSharedCommentArgs) => {
    const [token, data, accessToken] = args;
    const state = getCommentIdentityRuntimeState();
    const nativeAddSharedComment = state.nativeAddSharedComment;
    if (!nativeAddSharedComment) {
      throw new Error("公开评论接口尚未初始化");
    }

    let nextData = { ...data };
    const explicitName = nextData.guestName?.trim() || "";
    const storedName = readStoredGuestName();

    if (!explicitName && storedName) {
      nextData.guestName = storedName;
    }

    // 普通匿名访客没有登录令牌时，提交前先收集昵称，避免先产生一次 400 请求。
    if (!nextData.guestName && !hasAuthToken() && state.requester) {
      const requestedName = await state.requester();
      if (!requestedName) throw createCancelledCommentError();
      nextData.guestName = requestedName;
    }

    try {
      return await nativeAddSharedComment(token, nextData, accessToken);
    } catch (error) {
      // 浏览器可能残留已失效 token，前端误以为已登录；以后端结果为准，再补昵称重试一次。
      const requester = getCommentIdentityRuntimeState().requester;
      if (
        nextData.guestName
        || !requester
        || !isGuestNameRequiredError(error)
      ) {
        throw error;
      }

      const requestedName = await requester();
      if (!requestedName) throw error;
      return nativeAddSharedComment(
        token,
        { ...nextData, guestName: requestedName },
        accessToken,
      );
    }
  }) as AddSharedComment;
}

installCommentIdentityBridge();

interface SharedNoteCommentIdentityRuntimeProps {
  shareToken: string;
}

/**
 * 分享评论身份运行时壳。
 *
 * 原分享页只在“访客编辑”时收集昵称，但公开评论接口同样要求匿名访客携带
 * guestName，导致只评论的访客永远收到 GUEST_NAME_REQUIRED。这里保留原分享页，
 * 在评论 API 前按需弹出昵称面板，并把昵称保存在本机供后续评论复用。
 */
export default function SharedNoteCommentIdentityRuntime({
  shareToken,
}: SharedNoteCommentIdentityRuntimeProps) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const resolverRef = useRef<((name: string | null) => void) | null>(null);
  const pendingPromiseRef = useRef<Promise<string | null> | null>(null);

  const settleRequest = useCallback((name: string | null) => {
    const resolve = resolverRef.current;
    resolverRef.current = null;
    pendingPromiseRef.current = null;
    setOpen(false);
    resolve?.(name);
  }, []);

  const requestGuestName = useCallback<GuestNameRequester>(() => {
    const storedName = readStoredGuestName();
    if (storedName) return Promise.resolve(storedName);
    if (pendingPromiseRef.current) return pendingPromiseRef.current;

    setDraft("");
    setError("");
    setOpen(true);
    const promise = new Promise<string | null>((resolve) => {
      resolverRef.current = resolve;
    });
    pendingPromiseRef.current = promise;
    return promise;
  }, []);

  // 子组件在本次 render 后才可能触发评论，因此同步注册可消除 useEffect 首帧空窗。
  getCommentIdentityRuntimeState().requester = requestGuestName;

  useEffect(() => () => {
    const runtime = getCommentIdentityRuntimeState();
    if (runtime.requester === requestGuestName) {
      runtime.requester = null;
    }
    resolverRef.current?.(null);
    resolverRef.current = null;
    pendingPromiseRef.current = null;
  }, [requestGuestName]);

  const confirmNickname = useCallback(() => {
    const name = draft.trim();
    if (!name) {
      setError("请输入昵称");
      return;
    }
    if (name.length > 32) {
      setError("昵称过长，最多 32 个字符");
      return;
    }
    try {
      localStorage.setItem(GUEST_NAME_KEY, name);
    } catch {
      // 受限 WebView / 隐私模式下仍允许本次评论继续提交。
    }
    settleRequest(name);
  }, [draft, settleRequest]);

  return (
    <>
      <SharedNoteView shareToken={shareToken} />

      {open && (
        <div
          className="fixed inset-0 z-[160] flex items-center justify-center bg-black/40 px-4 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-labelledby="share-comment-nickname-title"
          onClick={(event) => {
            if (event.target === event.currentTarget) settleRequest(null);
          }}
        >
          <div className="w-full max-w-sm rounded-2xl border border-zinc-200 bg-white p-6 shadow-2xl dark:border-zinc-800 dark:bg-zinc-900">
            <div className="mb-5 flex flex-col items-center">
              <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-indigo-500/10">
                <UserCircle2 size={24} className="text-indigo-500" />
              </div>
              <h2
                id="share-comment-nickname-title"
                className="text-base font-semibold text-zinc-800 dark:text-zinc-200"
              >
                发表评论前填写昵称
              </h2>
              <p className="mt-1 text-center text-xs text-zinc-500">
                昵称会显示在评论旁边，方便笔记作者知道是谁参与了讨论。
              </p>
            </div>

            <div className="space-y-3">
              <input
                type="text"
                value={draft}
                onChange={(event) => {
                  setDraft(event.target.value);
                  if (error) setError("");
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    confirmNickname();
                  }
                }}
                placeholder="例如：小王"
                maxLength={32}
                autoFocus
                className="h-10 w-full rounded-xl border border-zinc-200 bg-zinc-50 px-4 text-sm text-zinc-800 placeholder:text-zinc-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200"
              />
              {error && <p className="text-xs text-red-500">{error}</p>}

              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  className="h-10 flex-1 text-sm"
                  onClick={() => settleRequest(null)}
                >
                  取消
                </Button>
                <Button
                  type="button"
                  className="h-10 flex-1 rounded-xl bg-indigo-500 font-medium text-white hover:bg-indigo-600"
                  disabled={!draft.trim()}
                  onClick={confirmNickname}
                >
                  确认并评论
                </Button>
              </div>

              <p className="text-center text-[10px] text-zinc-400">
                昵称仅保存在当前浏览器中，下次评论会自动使用。
              </p>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
