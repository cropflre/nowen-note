import { useEffect } from "react";
import { extractEmbedPassword, fillEmbedPasswordDocument } from "@/lib/embedPassword";

const BOUND_ATTR = "data-nowen-embed-password-bound";
const FALLBACK_CLASS = "nowen-embed-password-fallback";

type EmbedRecord = {
  iframe: HTMLIFrameElement;
  password: string;
  resolved: URL;
  requestId: string;
  status: HTMLElement;
};

const records = new WeakMap<HTMLIFrameElement, EmbedRecord>();
const pending = new Map<string, EmbedRecord>();

function randomRequestId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `embed-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}

export function isControlledSameOriginEmbed(url: URL, parentOrigin: string): boolean {
  if (url.origin !== parentOrigin) return false;
  return (
    url.searchParams.get("nowenEmbed") === "1" ||
    /^\/(?:embed|share|public|unlock|auth)(?:\/|$)/i.test(url.pathname)
  );
}

async function copySecret(password: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(password);
      return true;
    }
  } catch {
    // Fall back to a temporary input below.
  }

  try {
    const input = document.createElement("textarea");
    input.value = password;
    input.setAttribute("readonly", "");
    input.style.position = "fixed";
    input.style.opacity = "0";
    document.body.appendChild(input);
    input.select();
    const copied = document.execCommand?.("copy") ?? false;
    input.remove();
    return copied;
  } catch {
    return false;
  }
}

function createFallback(iframe: HTMLIFrameElement, password: string): HTMLElement {
  const existing = iframe.parentElement?.querySelector<HTMLElement>(`:scope > .${FALLBACK_CLASS}`);
  if (existing) return existing.querySelector<HTMLElement>("[data-nowen-embed-password-status]") || existing;

  const fallback = document.createElement("div");
  fallback.className = `${FALLBACK_CLASS} flex flex-wrap items-center gap-2 border-t border-app-border bg-app-surface px-3 py-2 text-[11px] text-tx-secondary`;
  fallback.setAttribute("role", "status");

  const status = document.createElement("span");
  status.dataset.nowenEmbedPasswordStatus = "1";
  status.textContent = "检测到密码/提取码，正在确认嵌入页面能力…";

  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "rounded-md border border-app-border px-2 py-1 font-medium hover:bg-app-hover";
  copy.textContent = "复制密码";
  copy.addEventListener("click", async () => {
    const copied = await copySecret(password);
    status.textContent = copied ? "密码已复制，请在嵌入页面中粘贴" : "复制失败，请在新窗口打开后手动输入";
  });

  fallback.append(status, copy);
  iframe.insertAdjacentElement("afterend", fallback);
  return status;
}

function setStatus(record: EmbedRecord, text: string, state: "pending" | "success" | "fallback" = "pending") {
  record.status.textContent = text;
  record.status.dataset.state = state;
}

function applySafeSandbox(record: EmbedRecord): void {
  if (record.resolved.origin !== window.location.origin) return;
  const tokens = new Set((record.iframe.getAttribute("sandbox") || "").split(/\s+/).filter(Boolean));
  tokens.add("allow-same-origin");

  // A same-origin frame with both scripts and allow-same-origin can remove its own
  // sandbox. Only Nowen-controlled embed routes keep scripts; ordinary same-origin
  // pages remain inspectable for a static password field but cannot execute scripts.
  if (!isControlledSameOriginEmbed(record.resolved, window.location.origin)) {
    tokens.delete("allow-scripts");
  }
  record.iframe.setAttribute("sandbox", Array.from(tokens).join(" "));
}

function sendOffer(record: EmbedRecord): void {
  try {
    record.iframe.contentWindow?.postMessage(
      {
        type: "nowen:embed-password-offer",
        requestId: record.requestId,
        source: "nowen-note",
      },
      record.resolved.origin,
    );
    setStatus(record, "检测到密码/提取码；页面确认后才会安全填充，也可直接复制", "fallback");
  } catch {
    setStatus(record, "无法自动确认嵌入页面，请复制密码后手动填写", "fallback");
  }
}

function tryApplyPassword(record: EmbedRecord): void {
  if (record.resolved.origin === window.location.origin) {
    try {
      const doc = record.iframe.contentDocument;
      if (doc && fillEmbedPasswordDocument(doc, record.password)) {
        setStatus(record, "密码已填写（未自动提交）", "success");
        return;
      }
    } catch {
      // Redirects and non-controlled pages can still deny DOM access.
    }
  }
  sendOffer(record);
}

function bindIframe(iframe: HTMLIFrameElement): void {
  if (iframe.hasAttribute(BOUND_ATTR) || !iframe.closest(".nowen-md-preview")) return;
  const rawSrc = iframe.getAttribute("src") || "";
  const password = extractEmbedPassword(rawSrc);
  if (!password) return;

  let resolved: URL;
  try {
    resolved = new URL(rawSrc, window.location.href);
  } catch {
    return;
  }
  if (resolved.protocol !== "http:" && resolved.protocol !== "https:") return;

  iframe.setAttribute(BOUND_ATTR, "1");
  const record: EmbedRecord = {
    iframe,
    password,
    resolved,
    requestId: randomRequestId(),
    status: createFallback(iframe, password),
  };
  records.set(iframe, record);
  pending.set(record.requestId, record);
  applySafeSandbox(record);
  iframe.addEventListener("load", () => tryApplyPassword(record));
  window.setTimeout(() => tryApplyPassword(record), 0);
}

function reconcile(root: ParentNode = document): void {
  root.querySelectorAll<HTMLIFrameElement>(".nowen-md-preview iframe").forEach(bindIframe);
}

function handleHandshake(event: MessageEvent): void {
  const data = event.data;
  if (!data || typeof data !== "object" || typeof data.requestId !== "string") return;
  const record = pending.get(data.requestId);
  if (!record || event.source !== record.iframe.contentWindow || event.origin !== record.resolved.origin) return;

  if (data.type === "nowen:embed-password-ready") {
    try {
      record.iframe.contentWindow?.postMessage(
        {
          type: "nowen:embed-password",
          requestId: record.requestId,
          password: record.password,
        },
        record.resolved.origin,
      );
      setStatus(record, "嵌入页面已确认，正在填写…");
    } catch {
      setStatus(record, "安全填充失败，请复制密码后手动填写", "fallback");
    }
    return;
  }

  if (data.type === "nowen:embed-password-applied") {
    pending.delete(record.requestId);
    setStatus(record, data.success === false ? "页面未能填写，请复制密码后手动输入" : "嵌入页面已确认填写（未自动提交）", data.success === false ? "fallback" : "success");
  }
}

export default function EmbedPasswordBridge() {
  useEffect(() => {
    reconcile();
    window.addEventListener("message", handleHandshake);
    const observer = new MutationObserver((entries) => {
      for (const entry of entries) {
        if (entry.type === "attributes" && entry.target instanceof HTMLIFrameElement) {
          const old = records.get(entry.target);
          if (old) pending.delete(old.requestId);
          entry.target.removeAttribute(BOUND_ATTR);
          bindIframe(entry.target);
          continue;
        }
        for (const node of Array.from(entry.addedNodes)) {
          if (!(node instanceof Element)) continue;
          if (node instanceof HTMLIFrameElement) bindIframe(node);
          reconcile(node);
        }
      }
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["src"],
    });
    return () => {
      observer.disconnect();
      window.removeEventListener("message", handleHandshake);
    };
  }, []);

  return null;
}
