import { useEffect, useState } from "react";
import {
  resolveAdaptiveWindowClass,
  type AdaptiveWindowClass,
} from "@/lib/adaptiveWindowLayout";

export interface AdaptiveWindowLayout {
  width: number;
  height: number;
  windowClass: AdaptiveWindowClass;
}
function readWindowLayout(): AdaptiveWindowLayout {
  const width = typeof window === "undefined" ? 1280 : window.innerWidth;
  const height = typeof window === "undefined" ? 800 : window.innerHeight;
  return {
    width,
    height,
    windowClass: resolveAdaptiveWindowClass(width, height),
  };
}

export function useAdaptiveWindowLayout(): AdaptiveWindowLayout {
  const [layout, setLayout] = useState(readWindowLayout);

  useEffect(() => {
    const update = () => {
      const next = readWindowLayout();
      setLayout((current) => (
        current.width === next.width
        && current.height === next.height
        && current.windowClass === next.windowClass
          ? current
          : next
      ));
    };

    update();
    window.addEventListener("resize", update, { passive: true });
    window.addEventListener("orientationchange", update, { passive: true });
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("orientationchange", update);
    };
  }, []);

  return layout;
}
