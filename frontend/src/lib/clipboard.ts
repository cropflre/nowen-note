import {
  hasPotentialSignedAttachmentUrl,
  stabilizeClipboardAttachmentLinks,
} from "@/lib/fileShareClipboard";

/**
 * 同步 execCommand("copy") 降级写入，兼容非 HTTPS（HTTP/局域网 IP）下的 Edge / Safari / iOS Safari，
 * 以及位于模态框（SettingsModal 等）焦点作用域内的复制。
 */
function execCommandCopy(value: string): boolean {
  if (typeof document === "undefined" || !document.body) return false;

  const previousActive = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const selection = typeof window !== "undefined" ? window.getSelection() : null;
  const savedRanges: Range[] = [];
  if (selection) {
    for (let i = 0; i < selection.rangeCount; i += 1) {
      savedRanges.push(selection.getRangeAt(i).cloneRange());
    }
  }

  // 若当前处于打开的对话框中，把临时 textarea 挂载到对话框内，避免模态框焦点陷阱拦截聚焦。
  const dialogContainer = previousActive?.closest?.('dialog[open], [role="dialog"]') as HTMLElement | null;
  const mountRoot = dialogContainer || document.body;

  const ta = document.createElement("textarea");
  ta.value = value;
  ta.setAttribute("readonly", "");
  ta.setAttribute("aria-hidden", "true");
  ta.tabIndex = -1;
  // fontSize 16px 防止 iOS Safari 聚焦缩放；固定在视口左上角但完全透明且不响应点击，避免滚动跳动。
  ta.style.position = "fixed";
  ta.style.top = "0";
  ta.style.left = "0";
  ta.style.width = "2px";
  ta.style.height = "2px";
  ta.style.padding = "0";
  ta.style.margin = "0";
  ta.style.border = "none";
  ta.style.outline = "none";
  ta.style.boxShadow = "none";
  ta.style.background = "transparent";
  ta.style.opacity = "0";
  ta.style.fontSize = "16px";
  ta.style.pointerEvents = "none";

  let ok = false;
  try {
    mountRoot.appendChild(ta);
    try {
      ta.focus({ preventScroll: true });
    } catch {
      ta.focus();
    }
    ta.select();
    try {
      ta.setSelectionRange(0, value.length);
    } catch {
      // 部分测试环境或受限输入控件忽略 setSelectionRange
    }

    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }

    // Safari 某些版本下 readonly textarea 的 select() 可能未建立有效选区，用 Range 再同步尝试一次。
    if (!ok && selection && typeof document.createRange === "function") {
      try {
        ta.removeAttribute("readonly");
        ta.contentEditable = "true";
        const range = document.createRange();
        range.selectNodeContents(ta);
        selection.removeAllRanges();
        selection.addRange(range);
        ta.setSelectionRange(0, value.length);
        ok = document.execCommand("copy");
      } catch {
        ok = false;
      }
    }
  } catch {
    ok = false;
  } finally {
    if (ta.parentNode) {
      ta.parentNode.removeChild(ta);
    }
    if (selection) {
      try {
        selection.removeAllRanges();
        for (const range of savedRanges) selection.addRange(range);
      } catch {
        // 忽略恢复选区时的 DOM 变更异常
      }
    }
    if (previousActive && previousActive.isConnected) {
      try {
        previousActive.focus({ preventScroll: true });
      } catch {
        // 忽略焦点恢复失败
      }
    }
  }
  return ok;
}

function canUseSecureAsyncClipboard(): boolean {
  if (typeof navigator === "undefined" || typeof navigator.clipboard?.writeText !== "function") {
    return false;
  }
  // 浏览器非 HTTPS 局域网部署下 window.isSecureContext === false，直接同步降级以保留 Safari/Edge 用户手势。
  if (typeof window !== "undefined" && window.isSecureContext === false) {
    return false;
  }
  return true;
}

/**
 * 统一的剪贴板复制工具
 * ---------------------------------------------------------------------------
 * - 普通文本零前置 await：在点击事件同步调用栈内直接触发 clipboard.writeText 或
 *   execCommand("copy")，避免 Safari / Edge 丢失 User Activation 导致复制失败；
 * - 非 HTTPS（HTTP/局域网 IP）下直接同步降级到 textarea + execCommand("copy")；
 * - 包含运行时附件 URL 的文本：先转换为稳定 file-share 链接（支持 Safari ClipboardItem
 *   Promise 写入以保留手势），若稳定链接创建失败则停止复制，绝不泄漏过期 URL。
 *
 * @returns 复制是否成功
 */
export function copyText(text: string): Promise<boolean> {
  if (text == null) return Promise.resolve(false);
  const raw = String(text);

  // 快路径：不含附件 URL 的普通文本，保持同步栈内直接触发剪贴板写入。
  if (!hasPotentialSignedAttachmentUrl(raw)) {
    if (canUseSecureAsyncClipboard()) {
      try {
        return Promise.resolve(navigator.clipboard.writeText(raw)).then(
          () => true,
          () => execCommandCopy(raw),
        );
      } catch {
        return Promise.resolve(execCommandCopy(raw));
      }
    }
    return Promise.resolve(execCommandCopy(raw));
  }

  // 含附件 URL：必须先做稳定分享转换；转换失败时直接返回 false，绝不回退泄漏临时 URL。
  const stabilizePromise = stabilizeClipboardAttachmentLinks(raw);

  // Safari / Edge 支持在同步点击栈中把 Promise 交给 ClipboardItem，防止异步等待后手势失效。
  if (
    canUseSecureAsyncClipboard()
    && typeof navigator.clipboard?.write === "function"
    && typeof ClipboardItem !== "undefined"
    && typeof Blob !== "undefined"
  ) {
    let stabilizedValue: string | null = null;
    let stabilizeFailed = false;
    const tracked = stabilizePromise.then(
      (value) => {
        stabilizedValue = value;
        return new Blob([value], { type: "text/plain" });
      },
      (error) => {
        stabilizeFailed = true;
        console.error("[clipboard] stable attachment share failed:", error);
        throw error;
      },
    );
    try {
      return Promise.resolve(
        navigator.clipboard.write([new ClipboardItem({ "text/plain": tracked })]),
      ).then(
        () => true,
        async () => {
          if (stabilizeFailed) return false;
          const resolved = stabilizedValue ?? await stabilizePromise.catch((error) => {
            console.error("[clipboard] stable attachment share failed:", error);
            return null;
          });
          if (resolved === null) return false;
          try {
            await navigator.clipboard.writeText(resolved);
            return true;
          } catch {
            return execCommandCopy(resolved);
          }
        },
      );
    } catch {
      // 落入下方常规异步路径
    }
  }

  return stabilizePromise.then(
    async (value) => {
      if (canUseSecureAsyncClipboard()) {
        try {
          await navigator.clipboard.writeText(value);
          return true;
        } catch {
          // 落入降级路径
        }
      }
      return execCommandCopy(value);
    },
    (error) => {
      console.error("[clipboard] stable attachment share failed:", error);
      return false;
    },
  );
}
