import { Capacitor, registerPlugin } from "@capacitor/core";

interface NativePrintPlugin {
  printNote(options: { html: string; jobName: string }): Promise<{ success: boolean }>;
}

export type NotePrintResult =
  | { ok: true; mode: "native" | "web" }
  | { ok: false; mode: "native" | "web"; error?: string };

const NativePrint = registerPlugin<NativePrintPlugin>("NativePrint");

function isAndroidNative(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android";
}

async function waitForPrintableAssets(doc: Document): Promise<void> {
  const images = Array.from(doc.images);
  await Promise.all(images.map((image) => {
    if (image.complete) return Promise.resolve();
    return new Promise<void>((resolve) => {
      image.addEventListener("load", () => resolve(), { once: true });
      image.addEventListener("error", () => resolve(), { once: true });
    });
  }));

  if (doc.fonts?.ready) await doc.fonts.ready;
}

async function printInBrowser(html: string): Promise<NotePrintResult> {
  const iframe = document.createElement("iframe");
  iframe.dataset.notePrint = "true";
  iframe.setAttribute("aria-hidden", "true");
  iframe.style.position = "fixed";
  iframe.style.right = "0";
  iframe.style.bottom = "0";
  iframe.style.width = "0";
  iframe.style.height = "0";
  iframe.style.border = "0";
  document.body.appendChild(iframe);

  const cleanup = () => {
    if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
  };

  try {
    const frameDocument = iframe.contentDocument;
    const frameWindow = iframe.contentWindow;
    if (!frameDocument || !frameWindow) throw new Error("PRINT_IFRAME_UNAVAILABLE");

    frameDocument.open();
    frameDocument.write(html);
    frameDocument.close();
    await waitForPrintableAssets(frameDocument);

    frameWindow.addEventListener("afterprint", cleanup, { once: true });
    frameWindow.focus();
    frameWindow.print();
    window.setTimeout(cleanup, 60_000);
    return { ok: true, mode: "web" };
  } catch (error) {
    cleanup();
    return { ok: false, mode: "web", error: String(error) };
  }
}

/** 将完整笔记 HTML 交给当前平台的系统打印能力。 */
export async function requestNotePrint(html: string, jobName: string): Promise<NotePrintResult> {
  if (!isAndroidNative()) return printInBrowser(html);

  try {
    const result = await NativePrint.printNote({ html, jobName });
    return result?.success
      ? { ok: true, mode: "native" }
      : { ok: false, mode: "native", error: "NATIVE_PRINT_FAILED" };
  } catch (error) {
    return { ok: false, mode: "native", error: String(error) };
  }
}
