import { useEffect } from "react";

import { decorateSiyuanRichTextCallouts } from "@/lib/siyuanRichTextCallout";

export default function SiyuanRichTextCalloutBridge() {
  useEffect(() => {
    if (typeof document === "undefined" || !document.body) return;

    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        decorateSiyuanRichTextCallouts(document);
      });
    };

    schedule();

    const observer = new MutationObserver(schedule);
    observer.observe(document.body, {
      childList: true,
      characterData: true,
      subtree: true,
    });

    return () => {
      observer.disconnect();
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, []);

  return null;
}
