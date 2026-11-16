import path from "node:path";

/**
 * Deterministic helpers for plain Markdown exports (Obsidian vaults, Joplin/Logseq Markdown folders).
 * They only change link syntax the importer cannot otherwise follow; the note text itself is kept.
 */

/** App configuration, trash and OS metadata that are never notes: hidden entries, macOS forks, Windows thumbnails. */
export function isIgnoredMigrationPath(name: string, files: { has(name: string): boolean }): boolean {
  const parts = name.split("/");
  if (parts.some((part) => part.startsWith(".")) || parts[0] === "__MACOSX") return true;
  const base = parts[parts.length - 1].toLowerCase();
  if (base === "thumbs.db" || base === "desktop.ini") return true;
  // Logseq keeps settings, backups and recycled pages beside the graph.
  return parts[0] === "logseq" && files.has("logseq/config.edn");
}

const NOTE_EXTENSIONS = [".md", ".markdown"];

function isInsideCode(content: string): boolean[] {
  const inside = new Array<boolean>(content.length).fill(false);
  let fence: string | null = null;
  let offset = 0;
  for (const line of content.split("\n")) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      inside.fill(true, offset, offset + line.length + 1);
      if (marker && marker[0] === fence[0] && marker.length >= fence.length && !line.slice(line.indexOf(marker) + marker.length).trim()) fence = null;
    } else if (marker) {
      fence = marker;
      inside.fill(true, offset, offset + line.length + 1);
    } else {
      // Inline code spans: a run of N backticks closes at the next run of exactly N backticks on the same line.
      const spans = /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g;
      for (let match = spans.exec(line); match; match = spans.exec(line)) inside.fill(true, offset + match.index, offset + match.index + match[0].length);
    }
    offset += line.length + 1;
  }
  return inside;
}

/** Path for a Markdown destination: works inside <…> and survives the importer's split on ? and #. */
function destination(relative: string): string | null {
  if (/[<>\n\r]/.test(relative)) return null;
  return relative.replace(/%/g, "%25").replace(/#/g, "%23").replace(/\?/g, "%3F");
}

function label(text: string): string {
  return text.replace(/\[/g, "(").replace(/\]/g, ")").replace(/\s+/g, " ").trim();
}

/** Obsidian resolves [[name]] by exact path first, then by the shortest path that ends with the name. */
function resolveWikiTarget(notePath: string, rawTarget: string, files: ReadonlyMap<string, unknown>, isAsset: (name: string) => boolean): string | null {
  const target = rawTarget.trim().replace(/^\.\//, "");
  if (!target || target.startsWith("/") || target.split("/").some((part) => part === ".." || part === ".")) return null;
  const hasExtension = NOTE_EXTENSIONS.includes(path.posix.extname(target).toLowerCase()) || isAsset(target);
  const candidates = hasExtension ? [target] : NOTE_EXTENSIONS.map((extension) => target + extension);
  for (const candidate of candidates) {
    for (const exact of [path.posix.join(path.posix.dirname(notePath), candidate), candidate]) {
      if (files.has(exact)) return exact;
    }
  }
  const wanted = candidates.map((candidate) => candidate.toLowerCase());
  const matches = [...files.keys()].filter((name) => wanted.some((candidate) => name.toLowerCase() === candidate || name.toLowerCase().endsWith("/" + candidate)));
  if (!matches.length) return null;
  const sameFolder = matches.filter((name) => path.posix.dirname(name) === path.posix.dirname(notePath));
  if (sameFolder.length === 1) return sameFolder[0];
  const shortest = Math.min(...matches.map((name) => name.split("/").length));
  const best = matches.filter((name) => name.split("/").length === shortest);
  return best.length === 1 ? best[0] : null;
}

/**
 * Rewrites Obsidian [[links]] and ![[embeds]] that point into the same package into standard Markdown links and
 * images, so the importer can attach the files and connect the notes. Code is left untouched; links whose target is
 * not in the package stay exactly as written.
 */
export function convertWikiLinks(notePath: string, content: string, files: ReadonlyMap<string, unknown>, isAsset: (name: string) => boolean, isImage: (name: string) => boolean) {
  if (!content.includes("[[")) return { content, unresolvedEmbeds: 0 };
  const code = isInsideCode(content);
  let unresolvedEmbeds = 0;
  const converted = content.replace(/(!?)\[\[([^[\]\n]+?)\]\]/g, (whole, embed: string, inner: string, offset: number) => {
    if (code[offset] || inner.startsWith("note:") || inner.startsWith("mindmap:")) return whole;
    const [targetWithAnchor, ...aliasParts] = inner.split("|");
    const alias = aliasParts.join("|").trim();
    const anchorAt = targetWithAnchor.indexOf("#");
    const target = anchorAt >= 0 ? targetWithAnchor.slice(0, anchorAt) : targetWithAnchor;
    const anchor = anchorAt >= 0 ? targetWithAnchor.slice(anchorAt + 1).trim() : "";
    const resolved = target.trim() ? resolveWikiTarget(notePath, target, files, isAsset) : null;
    if (!resolved) {
      if (embed) unresolvedEmbeds++;
      return whole;
    }
    const href = destination(path.posix.relative(path.posix.dirname(notePath), resolved) || path.posix.basename(resolved));
    if (!href) return whole;
    // Image sizes ("|300", "|300x200") are not captions.
    const text = label(alias && !/^\d+(?:x\d+)?$/.test(alias) ? alias : anchor ? `${target.trim()} > ${anchor}` : path.posix.basename(target.trim()));
    return embed && isImage(resolved) ? `![${text}](<${href}>)` : `[${text}](<${href}>)`;
  });
  return { content: converted, unresolvedEmbeds };
}

type FrontMatter = { title?: string; tags: string[]; createdAt?: string; updatedAt?: string };

/** Only times with an explicit offset are trusted; a bare local time would be a guess. */
function timestamp(value: string): string | undefined {
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)\s*(Z|[+-]\d{2}:?\d{2})$/i.exec(value);
  if (!match) return undefined;
  const offset = match[3].toUpperCase() === "Z" ? "Z" : match[3].replace(/^([+-]\d{2})(\d{2})$/, "$1:$2");
  const time = match[2].length === 5 ? `${match[2]}:00` : match[2];
  const date = new Date(`${match[1]}T${time}${offset}`);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/** A small YAML subset (scalars, inline and block lists) read from a leading front matter block. */
export function readFrontMatter(content: string): FrontMatter | null {
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(content);
  if (!match) return null;
  const lines = match[1].split(/\r?\n/);
  if (lines.length > 200) return null;
  const unquote = (value: string) => value.trim().replace(/^(["'])([\s\S]*)\1$/, "$2").trim();
  const result: FrontMatter = { tags: [] };
  for (let index = 0; index < lines.length; index++) {
    const entry = /^([A-Za-z_][\w-]*)[ \t]*:[ \t]*(.*)$/.exec(lines[index]);
    if (!entry) continue;
    const key = entry[1].toLowerCase();
    const value = entry[2].trim();
    let list: string[] | null = null;
    if (!value) {
      list = [];
      while (index + 1 < lines.length && /^\s*-\s+/.test(lines[index + 1])) list.push(unquote(lines[++index].replace(/^\s*-\s+/, "")));
    } else if (/^\[.*\]$/.test(value)) {
      list = value.slice(1, -1).split(",").map(unquote).filter(Boolean);
    }
    if (key === "title" && !list) result.title = unquote(value) || undefined;
    else if (key === "tags" || key === "tag") {
      result.tags = (list ?? value.split(/[,\s]+/).map(unquote))
        .map((tag) => tag.replace(/^#/, "").trim()).filter((tag) => tag && tag.length <= 100).slice(0, 100);
    } else if (!list && ["created", "date", "created_at", "createdat"].includes(key)) result.createdAt = timestamp(unquote(value)) ?? result.createdAt;
    else if (!list && ["updated", "modified", "updated_at", "updatedat"].includes(key)) result.updatedAt = timestamp(unquote(value)) ?? result.updatedAt;
  }
  result.tags = [...new Set(result.tags)];
  return result;
}
