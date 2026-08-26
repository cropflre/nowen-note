import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Capacitor } from "@capacitor/core";

import { getBaseUrl, resolveAttachmentUrl } from "@/lib/api";
import { extractNoteIdFromSignedAttachmentUrl } from "@/lib/attachmentSignedUrlRecovery";
import {
  acquireAttachmentRenderUrl,
  getAttachmentAccessSnapshot,
  getAttachmentRenderSource,
  invalidateOfflineAttachmentRenderUrl,
  subscribeAttachmentAccess,
} from "@/lib/noteAttachmentAccessBridge";
import { primeNoteAttachmentAccess } from "@/lib/noteAttachmentAccessPriming";

type ImageLoadState = {
  requestKey: string;
  renderSrc: string;
  loading: boolean;
  error: Error | null;
  preparingAndroidBlob: boolean;
  imageLoaded: boolean;
};

export type AttachmentImageRenderSource = {
  attachmentId: string | null;
  persistentSrc: string;
  resolvedSrc: string;
  renderSrc: string;
  renderKey: string;
  loading: boolean;
  error: Error | null;
  onLoad: () => void;
  onError: () => void;
};

const signedAccessRefreshInFlight = new Map<string, Promise<number>>();

function refreshSignedAccess(noteId: string): Promise<number> {
  const existing = signedAccessRefreshInFlight.get(noteId);
  if (existing) return existing;
  const pending = primeNoteAttachmentAccess(noteId, getBaseUrl(), { timeoutMs: 2_500 })
    .finally(() => {
      if (signedAccessRefreshInFlight.get(noteId) === pending) {
        signedAccessRefreshInFlight.delete(noteId);
      }
    });
  signedAccessRefreshInFlight.set(noteId, pending);
  return pending;
}

/**
 * 图片渲染边界统一使用的运行时地址解析。
 *
 * 持久化地址始终保持 `/api/attachments/:id`；signed URL、离线 Object URL 与
 * Android fetch 生成的 blob URL 只在此 hook 生命周期内使用。
 */
export function useAttachmentImageRenderSource(
  rawSrc: string | null | undefined,
  options: { enabled?: boolean } = {},
): AttachmentImageRenderSource {
  const enabled = options.enabled !== false;
  useSyncExternalStore(
    subscribeAttachmentAccess,
    getAttachmentAccessSnapshot,
    getAttachmentAccessSnapshot,
  );

  const source = getAttachmentRenderSource(rawSrc);
  const resolvedSrc = rawSrc ? resolveAttachmentUrl(source.persistentSrc) : "";
  const needsAndroidBlob = enabled
    && Capacitor.getPlatform() === "android"
    && !!source.attachmentId
    && /^https?:/i.test(resolvedSrc);
  const requestKey = [
    enabled ? "enabled" : "disabled",
    rawSrc || "",
    source.attachmentId || "",
    resolvedSrc,
  ].join("\n");
  const [state, setState] = useState<ImageLoadState>({
    requestKey: "",
    renderSrc: "",
    loading: false,
    error: null,
    preparingAndroidBlob: false,
    imageLoaded: false,
  });
  const signedRetryAttemptedRef = useRef(false);

  useEffect(() => {
    signedRetryAttemptedRef.current = false;
  }, [rawSrc]);

  useEffect(() => {
    const releaseRenderUrl = enabled && resolvedSrc
      ? acquireAttachmentRenderUrl(resolvedSrc)
      : () => undefined;
    let cancelled = false;
    let ownedBlobUrl: string | null = null;
    const abortController = typeof AbortController === "undefined" ? null : new AbortController();

    setState({
      requestKey,
      renderSrc: enabled ? resolvedSrc : "",
      loading: enabled && !!resolvedSrc,
      error: null,
      preparingAndroidBlob: needsAndroidBlob,
      imageLoaded: false,
    });

    if (needsAndroidBlob) {
      fetch(resolvedSrc, abortController ? { signal: abortController.signal } : undefined)
        .then((response) => {
          if (!response.ok) throw new Error(`fetch image failed: ${response.status}`);
          return response.blob();
        })
        .then((blob) => {
          const objectUrl = URL.createObjectURL(blob);
          if (cancelled) {
            URL.revokeObjectURL(objectUrl);
            return;
          }
          ownedBlobUrl = objectUrl;
          setState((current) => current.requestKey === requestKey ? {
            ...current,
            renderSrc: objectUrl,
            loading: true,
            error: null,
            preparingAndroidBlob: false,
            imageLoaded: false,
          } : current);
        })
        .catch((error: unknown) => {
          if (cancelled || (error instanceof DOMException && error.name === "AbortError")) return;
          const normalized = error instanceof Error ? error : new Error("图片加载失败");
          console.error("[attachment-image-render] Android blob fetch failed:", {
            attachmentId: source.attachmentId,
            originalSrc: rawSrc,
            resolvedSrc,
            error: normalized,
          });
          setState((current) => {
            if (current.requestKey !== requestKey) return current;
            if (current.imageLoaded) {
              return { ...current, preparingAndroidBlob: false };
            }
            return {
              ...current,
              loading: false,
              error: normalized,
              preparingAndroidBlob: false,
            };
          });
        });
    }

    return () => {
      cancelled = true;
      abortController?.abort();
      releaseRenderUrl();
      if (ownedBlobUrl) URL.revokeObjectURL(ownedBlobUrl);
    };
  }, [enabled, needsAndroidBlob, requestKey, resolvedSrc, source.attachmentId, rawSrc]);

  const activeState = state.requestKey === requestKey
    ? state
    : {
        requestKey,
        renderSrc: enabled ? resolvedSrc : "",
        loading: enabled && !!resolvedSrc,
        error: null,
        preparingAndroidBlob: needsAndroidBlob,
        imageLoaded: false,
      };
  const activeRenderSrc = activeState.renderSrc;

  const onLoad = useCallback(() => {
    signedRetryAttemptedRef.current = false;
    setState((current) => (
      current.requestKey === requestKey && current.renderSrc === activeRenderSrc
        ? { ...current, loading: false, error: null, imageLoaded: true }
        : current
    ));
  }, [activeRenderSrc, requestKey]);

  const onError = useCallback(() => {
    const recoveredOfflineUrl = invalidateOfflineAttachmentRenderUrl(activeRenderSrc);
    if (recoveredOfflineUrl) {
      setState((current) => current.requestKey === requestKey
        ? { ...current, loading: true, error: null, imageLoaded: false }
        : current);
      return;
    }

    // A signed URL can become invalid during a long editing session or after a server-side
    // permission/signing rotation. Refresh the note-scoped access map once, shared by every image
    // in that note, then let the bridge subscription re-resolve this persistent attachment node.
    // The server remains authoritative: extracting noteId from scope only selects the endpoint;
    // `/attachments/access/urls` still performs the real ACL check.
    const signedNoteId = source.signedUrlPresent
      ? extractNoteIdFromSignedAttachmentUrl(activeRenderSrc)
      : null;
    if (
      source.attachmentId
      && signedNoteId
      && !signedRetryAttemptedRef.current
      && !activeState.preparingAndroidBlob
    ) {
      signedRetryAttemptedRef.current = true;
      setState((current) => current.requestKey === requestKey
        ? { ...current, loading: true, error: null, imageLoaded: false }
        : current);
      void refreshSignedAccess(signedNoteId)
        .then((registered) => {
          if (registered > 0) {
            // A changed signed URL triggers the access-store subscription and a new requestKey.
            // If the server returned the exact same URL, do not leave this image spinning forever.
            setState((current) => current.requestKey === requestKey
              ? {
                  ...current,
                  loading: false,
                  error: new Error("图片访问已刷新，但资源仍无法加载"),
                  imageLoaded: false,
                }
              : current);
            return;
          }
          throw new Error("未获取到新的图片访问地址");
        })
        .catch((error: unknown) => {
          const normalized = error instanceof Error ? error : new Error("图片访问续签失败");
          setState((current) => current.requestKey === requestKey
            ? { ...current, loading: false, error: normalized, imageLoaded: false }
            : current);
        });
      return;
    }

    setState((current) => {
      if (current.requestKey !== requestKey || current.renderSrc !== activeRenderSrc) return current;
      // Android 的远程地址可能先触发 mixed-content 错误；blob fetch 尚在进行时不提前宣告失败。
      if (current.preparingAndroidBlob) return current;
      return {
        ...current,
        loading: false,
        error: new Error("图片加载失败"),
        imageLoaded: false,
      };
    });
  }, [activeRenderSrc, activeState.preparingAndroidBlob, requestKey, source.attachmentId, source.signedUrlPresent]);

  return {
    attachmentId: source.attachmentId,
    persistentSrc: source.persistentSrc,
    resolvedSrc,
    renderSrc: activeRenderSrc,
    renderKey: `${requestKey}\n${activeRenderSrc}`,
    loading: activeState.loading,
    error: activeState.error,
    onLoad,
    onError,
  };
}
