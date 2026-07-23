import React, { useEffect, useState } from "react";
import { Node, mergeAttributes, nodeInputRule } from "@tiptap/core";
import { NodeViewWrapper, ReactNodeViewRenderer } from "@tiptap/react";
import { AlertTriangle, Loader2, Quote } from "lucide-react";
import { api } from "@/lib/api";
import { openInternalNoteLink } from "@/lib/blockNavigation";
import { useLazyNodeView } from "@/hooks/useLazyNodeView";

const EMBED_RE = /!\[\[(note:[0-9a-f-]{36}#blk:[A-Za-z0-9_-]+)\]\]\s$/i;

function BlockEmbedCard({ href }: { href: string }) {
  const [state, setState] = useState<{ loading: boolean; data: any; error: boolean }>({ loading: true, data: null, error: false });
  useEffect(() => {
    let alive = true;
    setState({ loading: true, data: null, error: false });
    api.resolveNoteLink(href).then(
      (data) => alive && setState({ loading: false, data, error: !data.block }),
      () => alive && setState({ loading: false, data: null, error: true }),
    );
    return () => { alive = false; };
  }, [href]);
  if (state.loading) return <div className="flex items-center gap-2 p-3 text-xs text-tx-tertiary"><Loader2 size={14} className="animate-spin" />加载嵌入块…</div>;
  if (state.error || !state.data?.block) return <div className="flex items-center gap-2 p-3 text-xs text-amber-600"><AlertTriangle size={14} />源块已删除或无权访问</div>;
  return (
    <button type="button" onClick={() => openInternalNoteLink(href)} className="block w-full rounded-xl border border-app-border bg-app-surface p-3 text-left hover:bg-app-hover/60">
      <div className="mb-2 flex items-center gap-2 text-xs text-tx-tertiary"><Quote size={13} />{state.data.note.title} · {state.data.block.blockType}</div>
      <div className="whitespace-pre-wrap text-sm leading-6 text-tx-primary">{state.data.block.plainText || "空块"}</div>
    </button>
  );
}

function BlockEmbedNodeView({ node, selected }: any) {
  const {
    lazyEnabled,
    requiresInteraction,
    shouldRenderHeavyContent,
    observeRef,
    requestRender,
  } = useLazyNodeView<HTMLDivElement>({
    forceMount: selected,
    rootMargin: "1000px 0px",
    manualInLightweight: true,
  });
  return (
    <NodeViewWrapper
      ref={observeRef}
      className="my-3"
      data-nowen-block-embed={node.attrs.href}
      data-block-embed-runtime-state={shouldRenderHeavyContent ? "mounted" : "deferred"}
      style={{
        minHeight: shouldRenderHeavyContent ? undefined : 96,
        contentVisibility: lazyEnabled ? "auto" : undefined,
        containIntrinsicSize: lazyEnabled ? "auto 120px" : undefined,
      }}
    >
      {shouldRenderHeavyContent ? <BlockEmbedCard href={node.attrs.href} /> : (
        <button
          type="button"
          contentEditable={false}
          onMouseDown={(event) => { event.preventDefault(); event.stopPropagation(); }}
          onClick={(event) => { event.preventDefault(); event.stopPropagation(); requestRender(); }}
          className="flex min-h-24 w-full flex-col items-center justify-center gap-1 rounded-xl border border-app-border bg-app-hover/30 p-3 text-xs text-tx-tertiary"
        >
          <span>嵌入块暂未加载</span>
          <span>{requiresInteraction ? "点击加载预览" : "滚动到附近后自动加载"}</span>
        </button>
      )}
    </NodeViewWrapper>
  );
}

export const BlockEmbedExtension = Node.create({
  name: "blockEmbed",
  group: "block",
  atom: true,
  selectable: true,
  draggable: true,
  addAttributes() {
    return { href: { default: "" } };
  },
  parseHTML() {
    return [{ tag: "div[data-nowen-block-embed]", getAttrs: (node) => ({ href: (node as HTMLElement).getAttribute("data-nowen-block-embed") || "" }) }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-nowen-block-embed": HTMLAttributes.href })];
  },
  addNodeView() { return ReactNodeViewRenderer(BlockEmbedNodeView); },
  addInputRules() {
    return [nodeInputRule({ find: EMBED_RE, type: this.type, getAttributes: (match) => ({ href: match[1] }) })];
  },
});

export { BlockEmbedCard };
