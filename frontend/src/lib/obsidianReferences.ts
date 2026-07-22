import type {
  ObsidianAssetIndex, ObsidianEntry, ObsidianReferencePlan, ObsidianReferenceResolution,
} from "./obsidianImportTypes";
import {
  getObsidianExtension, isExternalAsset, normalizeObsidianPath, pathBasename, pathDirname,
  resolveVaultRelativePath, stripReferenceDecorations,
} from "./obsidianPath";

export function buildObsidianAssetIndex(entries: ObsidianEntry[]): ObsidianAssetIndex {
  const byPath = new Map<string, ObsidianEntry>();
  const byFoldedPath = new Map<string, ObsidianEntry | null>();
  const byBaseName = new Map<string, ObsidianEntry[]>();
  for (const entry of entries) {
    if (!entry.selected || entry.kind === "note" || entry.kind === "skipped") continue;
    const path = normalizeObsidianPath(entry.vaultPath);
    byPath.set(path, entry);
    const folded = path.toLocaleLowerCase();
    if (!byFoldedPath.has(folded)) byFoldedPath.set(folded, entry);
    else if (byFoldedPath.get(folded)?.vaultPath !== entry.vaultPath) byFoldedPath.set(folded, null);
    const base = pathBasename(path).toLocaleLowerCase();
    byBaseName.set(base, [...(byBaseName.get(base) || []), entry]);
  }
  return { byPath, byFoldedPath, byBaseName };
}

function distance(noteDirectory: string, assetPath: string): number {
  const a = normalizeObsidianPath(noteDirectory).split("/").filter(Boolean);
  const b = pathDirname(assetPath).split("/").filter(Boolean);
  let common = 0;
  while (common < a.length && common < b.length && a[common] === b[common]) common++;
  return a.length - common + b.length - common;
}

export function resolveObsidianAssetPath(rawTarget: string, notePath: string, index: ObsidianAssetIndex): ObsidianReferenceResolution {
  const original = String(rawTarget || "").trim();
  if (!original) return { status: "missing", rawTarget: original, normalizedTarget: "" };
  if (isExternalAsset(original)) return { status: "external", rawTarget: original, normalizedTarget: original };
  const cleaned = stripReferenceDecorations(original);
  const target = normalizeObsidianPath(cleaned);
  if (!getObsidianExtension(target) && !index.byPath.has(target)) {
    return { status: "note-link", rawTarget: original, normalizedTarget: target };
  }
  const noteDirectory = pathDirname(notePath);
  const candidates = [resolveVaultRelativePath(noteDirectory, cleaned), target].filter((value, i, all) => value && all.indexOf(value) === i);
  for (const candidate of candidates) {
    const exact = index.byPath.get(candidate);
    if (exact) return { status: "resolved", rawTarget: original, normalizedTarget: candidate, entry: exact };
  }
  for (const candidate of candidates) {
    const folded = index.byFoldedPath.get(candidate.toLocaleLowerCase());
    if (folded) return { status: "resolved", rawTarget: original, normalizedTarget: folded.vaultPath, entry: folded };
  }
  const sameName = index.byBaseName.get(pathBasename(target).toLocaleLowerCase()) || [];
  if (sameName.length === 1) return { status: "resolved", rawTarget: original, normalizedTarget: sameName[0].vaultPath, entry: sameName[0] };
  if (sameName.length > 1) {
    const ranked = sameName.map((entry) => ({ entry, score: distance(noteDirectory, entry.vaultPath) }))
      .sort((a, b) => a.score - b.score || a.entry.vaultPath.localeCompare(b.entry.vaultPath));
    if (ranked[0].score < ranked[1].score) return { status: "resolved", rawTarget: original, normalizedTarget: ranked[0].entry.vaultPath, entry: ranked[0].entry };
    return { status: "ambiguous", rawTarget: original, normalizedTarget: target, candidates: ranked.map((item) => item.entry.vaultPath) };
  }
  return { status: "missing", rawTarget: original, normalizedTarget: target };
}

function embedParts(inner: string): { target: string; label: string } {
  const pipe = inner.indexOf("|");
  const target = (pipe < 0 ? inner : inner.slice(0, pipe)).trim();
  const alias = pipe < 0 ? "" : inner.slice(pipe + 1).trim();
  return { target, label: alias || pathBasename(stripReferenceDecorations(target)) || target };
}

function markdownTarget(raw: string): string {
  let value = String(raw || "").trim();
  if (value.startsWith("<")) {
    const end = value.indexOf(">");
    if (end > 0) return value.slice(1, end);
  }
  return value.replace(/\s+["'][^"']*["']\s*$/, "").trim();
}

export function collectObsidianReferences(markdown: string, notePath: string, index: ObsidianAssetIndex): ObsidianReferencePlan[] {
  const plans: ObsidianReferencePlan[] = [];
  markdown.replace(/!\[\[([^\]]+)\]\]/g, (match, inner: string) => {
    const parsed = embedParts(inner);
    plans.push({ rawTarget: parsed.target, displayText: parsed.label, syntax: "obsidian-embed", resolution: resolveObsidianAssetPath(parsed.target, notePath, index) });
    return match;
  });
  markdown.replace(/(!?)\[([^\]]*)\]\(\s*(<[^>]+>|[^)\n]+?)\s*\)/g, (match, bang: string, label: string, raw: string) => {
    const target = markdownTarget(raw);
    plans.push({ rawTarget: target, displayText: label || pathBasename(stripReferenceDecorations(target)) || target, syntax: bang ? "markdown-image" : "markdown-link", resolution: resolveObsidianAssetPath(target, notePath, index) });
    return match;
  });
  markdown.replace(/<(?:img|video|audio|source|a)\b[^>]*?\b(?:src|href)=(['"])([^'"]+)\1[^>]*>/gi, (match, _q: string, target: string) => {
    plans.push({ rawTarget: target, displayText: pathBasename(stripReferenceDecorations(target)) || target, syntax: "html-asset", resolution: resolveObsidianAssetPath(target, notePath, index) });
    return match;
  });
  const seen = new Set<string>();
  return plans.filter((plan) => {
    const key = `${plan.syntax}:${plan.rawTarget}:${plan.resolution.entry?.vaultPath || plan.resolution.status}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function label(value: string): string { return String(value || "").replace(/([\\\[\]])/g, "\\$1"); }
function replacement(entry: ObsidianEntry, url: string, text: string): string {
  const safe = label(text || entry.fileName);
  if (entry.kind === "image") return `![${safe}](${url})`;
  if (entry.kind === "video") return `<video controls src="${url}"></video>`;
  if (entry.kind === "audio") return `<audio controls src="${url}"></audio>`;
  return `[📎 ${safe}](${url})`;
}

export function rewriteObsidianMarkdown(markdown: string, notePath: string, index: ObsidianAssetIndex, urls: Map<string, string>): string {
  let output = markdown.replace(/!\[\[([^\]]+)\]\]/g, (match, inner: string) => {
    const parsed = embedParts(inner);
    const resolved = resolveObsidianAssetPath(parsed.target, notePath, index);
    const url = resolved.entry ? urls.get(resolved.entry.vaultPath) : undefined;
    return resolved.entry && url ? replacement(resolved.entry, url, parsed.label) : match;
  });
  output = output.replace(/(!?)\[([^\]]*)\]\(\s*(<[^>]+>|[^)\n]+?)\s*\)/g, (match, bang: string, text: string, raw: string) => {
    const resolved = resolveObsidianAssetPath(markdownTarget(raw), notePath, index);
    const url = resolved.entry ? urls.get(resolved.entry.vaultPath) : undefined;
    if (!resolved.entry || !url) return match;
    if (bang && resolved.entry.kind === "image") return `![${label(text)}](${url})`;
    return bang ? replacement(resolved.entry, url, text || resolved.entry.fileName) : `[${label(text || resolved.entry.fileName)}](${url})`;
  });
  return output.replace(/(<(?:img|video|audio|source|a)\b[^>]*?\b(?:src|href)=)(['"])([^'"]+)(\2)/gi, (match, prefix: string, quote: string, target: string, suffix: string) => {
    const resolved = resolveObsidianAssetPath(target, notePath, index);
    const url = resolved.entry ? urls.get(resolved.entry.vaultPath) : undefined;
    return url ? `${prefix}${quote}${url}${suffix}` : match;
  });
}
