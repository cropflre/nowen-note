import { useEffect } from "react";
import { extractEmbedPassword, fillEmbedPasswordDocument } from "@/lib/embedPassword";

const BOUND_ATTR = "data-nowen-embed-password-bound";

function tryApplyPassword(iframe: HTMLIFrameElement): void {
  if (!iframe.closest(".nowen-md-preview")) return;
  const rawSrc = iframe.getAttribute("src") || "";
  const password = extractEmbedPassword(rawSrc);
  if (!password) return;

  let resolved: URL;
  try {
    resolved = new URL(rawSrc, window.location.href);
  } catch {
    return;
  }

  // Cross-origin frames cannot be inspected by the parent. Sending a narrowly
  // scoped message lets compatible self-hosted pages opt in without weakening
  // the iframe sandbox or exposing the password to unrelated origins.
  try {
    iframe.contentWindow?.postMessage(
      { type: "nowen:embed-password", password, sourceUrl: resolved.toString() },
      resolved.origin,
    );
  } catch {
    /* best effort */
  }

  if (resolved.origin !== window.location.origin) return;
  try {
    const doc = iframe.contentDocument;
    if (doc) fillEmbedPasswordDocument(doc, password);
  } catch {
    /* the browser may still deny access for an origin-changing redirect */
  }
}

function bindIframe(iframe: HTMLIFrameElement): void {
  if (iframe.hasAttribute(BOUND_ATTR)) return;
  iframe.setAttribute(BOUND_ATTR, "1");
  iframe.addEventListener("load", () => tryApplyPassword(iframe));

  // Cached/same-document frames may already be complete before the observer sees them.
  window.setTimeout(() => tryApplyPassword(iframe), 0);
}

function reconcile(root: ParentNode = document): void {
  root.querySelectorAll<HTMLIFrameElement>(".nowen-md-preview iframe").forEach(bindIframe);
}

export default function EmbedPasswordBridge() {
  useEffect(() => {
    reconcile();
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === "attributes" && record.target instanceof HTMLIFrameElement) {
          tryApplyPassword(record.target);
          continue;
        }
        for (const node of Array.from(record.addedNodes)) {
          if (!(node instanceof Element)) continue;
          if (node instanceof HTMLIFrameElement && node.closest(".nowen-md-preview")) bindIframe(node);
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
    return () => observer.disconnect();
  }, []);

  return null;
}
