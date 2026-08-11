import React, { useCallback, useEffect, useState } from "react";
import BaseMermaidView, { MermaidView as NamedBaseMermaidView } from "./MermaidView";
import { useLazyNodeView } from "@/hooks/useLazyNodeView";
import "./mermaid-inline-preview.css";

export * from "./MermaidView";

type MermaidViewProps = React.ComponentProps<typeof BaseMermaidView>;

/**
 * Runtime shell for Mermaid previews.
 *
 * The source editor and ProseMirror contentDOM remain mounted. Only the expensive Mermaid module,
 * parse pass and SVG DOM are deferred, so selection and document positions stay continuous.
 */
export const MermaidView: React.FC<MermaidViewProps> = (props) => {
  const source = props.source || "";
  const {
    lazyEnabled,
    requiresInteraction,
    shouldRenderHeavyContent,
    observeRef,
    requestRender,
  } = useLazyNodeView<HTMLDivElement>({
    forceMount: source.trim().length === 0,
    rootMargin: "1200px 0px",
    manualInLightweight: true,
  });
  const [shellElement, setShellElement] = useState<HTMLDivElement | null>(null);

  const runtimeRef = useCallback((next: HTMLDivElement | null) => {
    observeRef(next);
    setShellElement(next);
  }, [observeRef]);

  // Rich-text Mermaid previews are stored as codeBlock nodes, but in preview mode they should read
  // like an inline diagram rather than a code card. Mark only the owning ProseMirror code block so
  // the CSS can remove the code chrome. Markdown/shared Mermaid views and the standalone mind-map
  // module are intentionally untouched.
  useEffect(() => {
    const codeBlock = shellElement?.closest<HTMLElement>(".code-block-wrapper");
    if (!codeBlock || !codeBlock.closest(".ProseMirror")) return;

    codeBlock.dataset.nowenMermaidInlinePreview = "true";
    return () => {
      if (codeBlock.dataset.nowenMermaidInlinePreview === "true") {
        delete codeBlock.dataset.nowenMermaidInlinePreview;
      }
    };
  }, [shellElement]);

  return (
    <div
      ref={runtimeRef}
      data-mermaid-runtime-state={shouldRenderHeavyContent ? "mounted" : "deferred"}
      style={{
        minHeight: shouldRenderHeavyContent ? undefined : 150,
        contentVisibility: lazyEnabled ? "auto" : undefined,
        containIntrinsicSize: lazyEnabled ? "auto 240px" : undefined,
      }}
    >
      {shouldRenderHeavyContent ? (
        <NamedBaseMermaidView {...props} />
      ) : (
        <div
          contentEditable={false}
          className={`mermaid-view-deferred flex min-h-[150px] flex-col items-center justify-center gap-2 rounded-md border border-app-border bg-app-hover/30 px-4 py-6 text-center text-tx-tertiary ${props.className ?? ""}`}
        >
          <span className="text-xs font-medium text-tx-secondary">Mermaid 图表暂未渲染</span>
          <span className="text-[11px] leading-relaxed">
            {requiresInteraction
              ? "轻量编辑模式下需手动加载，源码仍可正常编辑和保存"
              : "滚动到图表附近后会自动渲染"}
          </span>
          <button
            type="button"
            className="mt-1 rounded-md border border-app-border bg-app-surface px-2.5 py-1 text-xs text-tx-secondary transition-colors hover:bg-app-hover hover:text-tx-primary"
            onMouseDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              requestRender();
            }}
          >
            立即渲染
          </button>
        </div>
      )}
    </div>
  );
};

export default MermaidView;
