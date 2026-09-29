import { normalizeCodeBlockLanguageId } from "@/lib/codeBlockLanguageRegistry";

const parsers: Record<string, string> = {
  json: "json-stringify",
  javascript: "babel", jsx: "babel",
  typescript: "typescript", tsx: "typescript",
  html: "html", css: "css", scss: "scss", less: "less", yaml: "yaml",
};

export type CodeBlockFormatErrorReason = "unsupported" | "invalid" | "changed" | "readOnly";

export class CodeBlockFormatError extends Error {
  constructor(readonly reason: CodeBlockFormatErrorReason) {
    super(reason);
  }
}

export function canFormatCodeBlock(language: string): boolean {
  const id = normalizeCodeBlockLanguageId(language);
  return !id || id === "auto" || id === "text" || Object.prototype.hasOwnProperty.call(parsers, id);
}

/** Load browser parsers only on demand; source text never leaves the device. */
export async function formatCodeBlock(code: string, language: string): Promise<string> {
  if (!canFormatCodeBlock(language)) throw new CodeBlockFormatError("unsupported");
  if (!code.trim()) return code;
  const id = normalizeCodeBlockLanguageId(language);
  const parser = parsers[id] || "json-stringify";
  try {
    // Validate strict JSON without serializing the parsed values (large numbers lose precision).
    if (parser === "json-stringify") JSON.parse(code);
    const prettier = await import("prettier/standalone");
    let plugins;
    if (parser === "typescript") {
      plugins = await Promise.all([import("prettier/plugins/typescript"), import("prettier/plugins/estree")]);
    } else if (parser === "babel" || parser === "json-stringify") {
      plugins = await Promise.all([import("prettier/plugins/babel"), import("prettier/plugins/estree")]);
    } else if (parser === "html") {
      plugins = [await import("prettier/plugins/html")];
    } else if (parser === "yaml") {
      plugins = [await import("prettier/plugins/yaml")];
    } else {
      plugins = [await import("prettier/plugins/postcss")];
    }
    return (await prettier.format(code, {
      parser, plugins, tabWidth: 2, useTabs: false, endOfLine: "lf",
      embeddedLanguageFormatting: "off",
    })).replace(/\n$/, "");
  } catch {
    // Parser errors can include source fragments. Show a safe, localized message instead.
    throw new CodeBlockFormatError("invalid");
  }
}
