import React, { useRef } from "react";
import DiaryCenterImpl from "./DiaryCenterImpl";
import DiaryExperienceBridge from "./diary/DiaryExperienceBridge";

/**
 * Compatibility shell around the existing diary center. The bridge adds the
 * lightweight Markdown/report interaction without duplicating diary data state.
 */
export default function DiaryCenter() {
  const rootRef = useRef<HTMLDivElement>(null);
  return (
    <div ref={rootRef} className="contents">
      <DiaryCenterImpl />
      <DiaryExperienceBridge rootRef={rootRef} />
    </div>
  );
}
