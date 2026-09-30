import React, { useMemo, useState, useSyncExternalStore } from "react";
import { Check, Copy, Maximize2, Minimize2 } from "lucide-react";
import { createCodeBlockLowlight } from "@/lib/codeBlockLowlight";
import { getCodeBlockLanguageDisplayLabel } from "@/lib/codeBlockLanguageRegistry";
import { instrumentPhaseALowlight } from "@/lib/phaseAPerfDiagnostics";
import { isPlainTextLanguage } from "@/lib/codeBlockHighlightPlugin";
import { copyText } from "@/lib/clipboard";
import { cn } from "@/lib/utils";
import { CodeBlockFormatButton } from "@/components/CodeBlockFormatButton";
import {
  CODE_BLOCK_TOOLBAR_CLASS,
  CODE_BLOCK_TOOL_BUTTON_CLASS,
  CODE_BLOCK_WRAPPER_CLASS,
  getCodeBlockCollapseMode,
  shouldCollapseCodeBlock,
  subscribeCodeBlockCollapseMode,
} from "@/lib/codeBlockPresentation";
import "@/markdown-code-highlight.css";

const lowlight = instrumentPhaseALowlight(createCodeBlockLowlight());

function normalizeLanguage(className?: string): string {
  return className?.match(/(?:^|\s)language-([^\s]+)/)?.[1]?.toLowerCase() || "text";
}

function renderLowlightNode(node: any, key: React.Key): React.ReactNode {
  if (!node) return null;
  if (node.type === "text") return node.value;
  if (node.type !== "element") return null;

  const properties = { ...(node.properties || {}), key } as Record<string, unknown>;
  if (Array.isArray(properties.className)) properties.className = properties.className.join(" ");
  return React.createElement(
    node.tagName,
    properties,
    (node.children || []).map((child: any, index: number) => renderLowlightNode(child, index)),
  );
}

export interface MarkdownCodeBlockProps {
  className?: string;
  children?: React.ReactNode;
  onFormat?: () => Promise<void>;
}

/** Shared Markdown code block with the same core affordances as rich-text code blocks. */
export function MarkdownCodeBlock({ className, children, onFormat }: MarkdownCodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const [collapseOverride, setCollapseOverride] = useState<boolean | null>(null);
  const collapseMode = useSyncExternalStore(
    subscribeCodeBlockCollapseMode,
    getCodeBlockCollapseMode,
    getCodeBlockCollapseMode,
  );
  const language = normalizeLanguage(className);
  const code = String(children ?? "").replace(/\n$/, "");

  const highlighted = useMemo(() => {
    if (isPlainTextLanguage(language)) return code;
    try {
      const tree = lowlight.highlight(language, code);
      return tree.children.map((node, index) => renderLowlightNode(node, index));
    } catch {
      return code;
    }
  }, [code, language]);

  const handleCopy = async () => {
    const ok = await copyText(code);
    if (!ok) return;
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  };

  const label = getCodeBlockLanguageDisplayLabel(language);
  const lineCount = code ? code.split("\n").length : 0;
  const collapsed = collapseOverride ?? shouldCollapseCodeBlock(collapseMode, lineCount);

  return (
    <div className={CODE_BLOCK_WRAPPER_CLASS}>
      <div className={CODE_BLOCK_TOOLBAR_CLASS}>
        <div className="flex min-w-0 items-center gap-2">
          <span className="font-medium text-tx-secondary">{label}</span>
          <span className="opacity-50">·</span>
          <span>{lineCount} {lineCount === 1 ? "line" : "lines"}</span>
        </div>
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={() => setCollapseOverride(!collapsed)}
            className={CODE_BLOCK_TOOL_BUTTON_CLASS}
            title={collapsed ? "展开代码" : "折叠代码"}
            aria-label={collapsed ? "展开代码" : "折叠代码"}
          >
            {collapsed ? <Maximize2 size={13} /> : <Minimize2 size={13} />}
            <span className="hidden sm:inline">{collapsed ? "展开" : "折叠"}</span>
          </button>
          {onFormat && <CodeBlockFormatButton language={language} onFormat={onFormat} />}
          <button
            type="button"
            onClick={() => void handleCopy()}
            className={CODE_BLOCK_TOOL_BUTTON_CLASS}
            aria-label={copied ? "Copied" : "Copy code"}
            title={copied ? "Copied" : "Copy code"}
          >
            {copied ? <Check size={13} /> : <Copy size={13} />}
            <span>{copied ? "Copied" : "Copy"}</span>
          </button>
        </div>
      </div>
      <div className="relative">
        <pre
          className="code-block-pre max-w-full overflow-x-auto p-4 text-sm leading-6 [tab-size:2]"
          style={collapsed ? { maxHeight: "120px", overflow: "hidden" } : undefined}
        >
          <code className={cn("code-block-content nowen-code-highlight font-mono text-tx-primary", className)}>{highlighted}</code>
        </pre>
        {collapsed && (
          <div
            className="absolute bottom-0 left-0 right-0 h-12 pointer-events-none"
            style={{ background: "linear-gradient(transparent, var(--code-bg, #1e1e2e))" }}
          />
        )}
      </div>
    </div>
  );
}

export function isMarkdownBlockCode(className?: string): boolean {
  return /(?:^|\s)language-/.test(className || "");
}
