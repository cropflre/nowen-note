import React, { useMemo, useState } from "react";
import { Check, Copy } from "lucide-react";
import { common, createLowlight } from "lowlight";
import { instrumentPhaseALowlight } from "@/lib/phaseAPerfDiagnostics";
import { isPlainTextLanguage } from "@/lib/codeBlockHighlightPlugin";
import { copyText } from "@/lib/clipboard";
import { cn } from "@/lib/utils";

const lowlight = instrumentPhaseALowlight(createLowlight(common));

const LANGUAGE_LABELS: Record<string, string> = {
  bash: "Bash",
  shell: "Shell",
  sh: "Shell",
  css: "CSS",
  html: "HTML",
  xml: "XML",
  javascript: "JavaScript",
  js: "JavaScript",
  jsx: "JSX",
  json: "JSON",
  markdown: "Markdown",
  md: "Markdown",
  python: "Python",
  py: "Python",
  sql: "SQL",
  typescript: "TypeScript",
  ts: "TypeScript",
  tsx: "TSX",
  yaml: "YAML",
  yml: "YAML",
};

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
}

/** Shared Markdown code block with the same core affordances as rich-text code blocks. */
export function MarkdownCodeBlock({ className, children }: MarkdownCodeBlockProps) {
  const [copied, setCopied] = useState(false);
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

  const label = LANGUAGE_LABELS[language] || (language === "text" ? "Text" : language.toUpperCase());
  const lineCount = code ? code.split("\n").length : 0;

  return (
    <div className="group/code my-4 overflow-hidden rounded-xl border border-app-border bg-app-hover/70 shadow-sm">
      <div className="flex h-9 items-center gap-2 border-b border-app-border/70 bg-app-surface/80 px-3 text-[11px] text-tx-tertiary">
        <span className="font-medium text-tx-secondary">{label}</span>
        <span className="opacity-50">·</span>
        <span>{lineCount} {lineCount === 1 ? "line" : "lines"}</span>
        <button
          type="button"
          onClick={() => void handleCopy()}
          className="ml-auto inline-flex h-7 items-center gap-1 rounded-md px-2 transition hover:bg-app-hover hover:text-tx-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary/50"
          aria-label={copied ? "Copied" : "Copy code"}
          title={copied ? "Copied" : "Copy code"}
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
          <span>{copied ? "Copied" : "Copy"}</span>
        </button>
      </div>
      <pre className="max-w-full overflow-x-auto p-4 text-sm leading-6 [tab-size:2]">
        <code className={cn("font-mono text-tx-primary", className)}>{highlighted}</code>
      </pre>
    </div>
  );
}

export function isMarkdownBlockCode(className?: string): boolean {
  return /(?:^|\s)language-/.test(className || "");
}
