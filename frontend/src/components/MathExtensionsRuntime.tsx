import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  NodeViewWrapper,
  ReactNodeViewRenderer,
  type NodeViewProps,
} from "@tiptap/react";
import { TextSelection } from "@tiptap/pm/state";

import MathView from "@/components/MathView";
import { useLazyNodeView } from "@/hooks/useLazyNodeView";
import {
  MathInline as BaseMathInline,
  MathBlock as BaseMathBlock,
} from "./MathExtensions";

export * from "./MathExtensions";

interface RuntimeMathNodeViewProps extends NodeViewProps {
  displayMode: boolean;
}

function DeferredMathPlaceholder({
  latex,
  displayMode,
  requiresInteraction,
  onLoad,
  onEdit,
}: {
  latex: string;
  displayMode: boolean;
  requiresInteraction: boolean;
  onLoad: () => void;
  onEdit: (event: React.MouseEvent) => void;
}) {
  const source = latex.trim() || (displayMode ? "块级公式" : "公式");
  if (!displayMode) {
    return (
      <code
        data-math-placeholder="inline"
        className="inline-block max-w-[24rem] cursor-pointer overflow-hidden text-ellipsis whitespace-nowrap rounded border border-bd-secondary bg-app-bg-secondary px-1 py-0.5 align-middle text-[11px] text-tx-secondary"
        title={requiresInteraction ? "轻量编辑模式：单击渲染，双击编辑" : "滚动到附近后自动渲染"}
        onClick={onEdit}
      >
        ${source}$
      </code>
    );
  }

  return (
    <div
      data-math-placeholder="block"
      className="my-2 flex min-h-20 flex-col items-center justify-center gap-2 rounded-md border border-dashed border-bd-secondary bg-app-bg-secondary px-4 py-3 text-center"
      onDoubleClick={onEdit}
    >
      <code className="max-w-full overflow-hidden text-ellipsis whitespace-nowrap text-[12px] text-tx-secondary">
        {source}
      </code>
      <span className="text-[11px] text-tx-tertiary">
        {requiresInteraction ? "轻量编辑模式下暂不渲染公式" : "滚动到附近后自动渲染"}
      </span>
      <button
        type="button"
        className="rounded-md border border-bd-secondary bg-app-elevated px-2.5 py-1 text-[11px] text-tx-primary hover:bg-app-hover"
        onMouseDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onLoad();
        }}
      >
        立即渲染
      </button>
    </div>
  );
}

export const RuntimeMathNodeView: React.FC<RuntimeMathNodeViewProps> = ({
  node,
  selected,
  updateAttributes,
  deleteNode,
  editor,
  getPos,
  displayMode,
}) => {
  const latex: string = node.attrs.latex || "";
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(latex);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const {
    lazyEnabled,
    requiresInteraction,
    shouldRenderHeavyContent,
    observeRef,
    requestRender,
  } = useLazyNodeView<HTMLElement>({
    forceMount: selected || editing,
    rootMargin: "1000px 0px",
    manualInLightweight: true,
  });

  useEffect(() => {
    if (!editing) setDraft(latex);
  }, [editing, latex]);

  useEffect(() => {
    if (!editing || !textareaRef.current) return;
    textareaRef.current.focus();
    textareaRef.current.select();
  }, [editing]);

  const setWrapperRef = useCallback((element: HTMLElement | null) => {
    observeRef(element);
  }, [observeRef]);

  const selectNode = useCallback(() => {
    const pos = typeof getPos === "function" ? getPos() : null;
    if (pos == null || !editor) return;
    try {
      editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, pos)));
    } catch {
      // The document may have changed between an async render and the click. Selection is optional.
    }
  }, [editor, getPos]);

  const enterEditing = useCallback((event?: React.MouseEvent) => {
    event?.preventDefault();
    event?.stopPropagation();
    requestRender();
    selectNode();
    setEditing(true);
  }, [requestRender, selectNode]);

  const commit = useCallback(() => {
    const next = draft.trim();
    if (!next) {
      deleteNode();
      return;
    }
    if (next !== latex) updateAttributes({ latex: next });
    setEditing(false);
    setTimeout(() => editor?.commands.focus(), 0);
  }, [deleteNode, draft, editor, latex, updateAttributes]);

  const cancel = useCallback(() => {
    setDraft(latex);
    setEditing(false);
  }, [latex]);

  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      cancel();
      return;
    }
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey || !displayMode)) {
      event.preventDefault();
      commit();
    }
  }, [cancel, commit, displayMode]);

  if (editing) {
    return (
      <NodeViewWrapper
        as={displayMode ? "div" : "span"}
        ref={setWrapperRef}
        className={`math-node-editing ${displayMode ? "block my-2" : "inline-block align-middle mx-0.5"}`}
        contentEditable={false}
      >
        <div className="overflow-hidden rounded-md border border-indigo-300 bg-app-bg shadow-sm dark:border-indigo-600">
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
            onKeyDown={handleKeyDown}
            rows={displayMode ? Math.max(2, draft.split("\n").length) : 1}
            className="w-full min-w-[120px] resize-none bg-transparent px-2 py-1 font-mono text-[12px] text-tx-primary outline-none"
            placeholder={displayMode ? "输入 LaTeX，Cmd/Ctrl+Enter 保存，Esc 取消" : "输入 LaTeX，Enter 保存"}
            spellCheck={false}
          />
          <div className="border-t border-bd-secondary bg-app-bg-secondary px-2 py-1">
            <MathView source={draft} display={displayMode} />
          </div>
        </div>
      </NodeViewWrapper>
    );
  }

  return (
    <NodeViewWrapper
      as={displayMode ? "div" : "span"}
      ref={setWrapperRef}
      className={`math-node ${displayMode ? "math-node-block" : "math-node-inline"} ${selected ? "math-selected" : ""}`}
      data-heavy-node-state={shouldRenderHeavyContent ? "mounted" : "deferred"}
      contentEditable={false}
      draggable={false}
      style={{
        contentVisibility: lazyEnabled && displayMode ? "auto" : undefined,
        containIntrinsicSize: lazyEnabled && displayMode ? "auto 96px" : undefined,
      }}
    >
      {shouldRenderHeavyContent ? (
        <MathView
          source={latex}
          display={displayMode}
          selected={selected}
          onClick={(event) => {
            if (event.detail >= 2) enterEditing(event);
            else selectNode();
          }}
        />
      ) : (
        <DeferredMathPlaceholder
          latex={latex}
          displayMode={displayMode}
          requiresInteraction={requiresInteraction}
          onLoad={requestRender}
          onEdit={(event) => {
            if (event.detail >= 2) enterEditing(event);
            else {
              requestRender();
              selectNode();
            }
          }}
        />
      )}
    </NodeViewWrapper>
  );
};

export const MathInline = BaseMathInline.extend({
  addNodeView() {
    return ReactNodeViewRenderer((props: NodeViewProps) => (
      <RuntimeMathNodeView {...props} displayMode={false} />
    ));
  },
});

export const MathBlock = BaseMathBlock.extend({
  addNodeView() {
    return ReactNodeViewRenderer((props: NodeViewProps) => (
      <RuntimeMathNodeView {...props} displayMode />
    ));
  },
});

export const MathExtensions = [MathInline, MathBlock];
