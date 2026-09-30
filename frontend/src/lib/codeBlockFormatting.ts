import { normalizeCodeBlockLanguageId } from "@/lib/codeBlockLanguageRegistry";

type FormatterPluginGroup =
  | "babel-estree"
  | "typescript-estree"
  | "flow-estree"
  | "html"
  | "postcss"
  | "yaml"
  | "graphql"
  | "markdown"
  | "glimmer";

type FormatterSpec = {
  parser: string;
  plugins: FormatterPluginGroup;
  strictJson?: boolean;
};

const formatters: Readonly<Record<string, FormatterSpec>> = {
  json: { parser: "json-stringify", plugins: "babel-estree", strictJson: true },
  jsonc: { parser: "jsonc", plugins: "babel-estree" },
  json5: { parser: "json5", plugins: "babel-estree" },

  javascript: { parser: "babel", plugins: "babel-estree" },
  jsx: { parser: "babel", plugins: "babel-estree" },
  flow: { parser: "flow", plugins: "flow-estree" },
  typescript: { parser: "typescript", plugins: "typescript-estree" },
  tsx: { parser: "typescript", plugins: "typescript-estree" },

  html: { parser: "html", plugins: "html" },
  vue: { parser: "vue", plugins: "html" },
  angular: { parser: "angular", plugins: "html" },
  lwc: { parser: "lwc", plugins: "html" },
  mjml: { parser: "mjml", plugins: "html" },
  handlebars: { parser: "glimmer", plugins: "glimmer" },
  glimmer: { parser: "glimmer", plugins: "glimmer" },

  css: { parser: "css", plugins: "postcss" },
  scss: { parser: "scss", plugins: "postcss" },
  less: { parser: "less", plugins: "postcss" },
  yaml: { parser: "yaml", plugins: "yaml" },
  graphql: { parser: "graphql", plugins: "graphql" },
  markdown: { parser: "markdown", plugins: "markdown" },
  mdx: { parser: "mdx", plugins: "markdown" },
};

export type CodeBlockFormatErrorReason = "unsupported" | "invalid" | "changed" | "readOnly";

export class CodeBlockFormatError extends Error {
  constructor(readonly reason: CodeBlockFormatErrorReason) {
    super(reason);
  }
}

function getFormatterSpec(language: string): FormatterSpec | null {
  const id = normalizeCodeBlockLanguageId(language);
  if (!id || id === "auto" || id === "text") return formatters.json;
  return formatters[id] || null;
}

export function canFormatCodeBlock(language: string): boolean {
  return getFormatterSpec(language) !== null;
}

async function loadFormatterPlugins(group: FormatterPluginGroup): Promise<any[]> {
  if (group === "babel-estree") {
    return Promise.all([import("prettier/plugins/babel"), import("prettier/plugins/estree")]);
  }
  if (group === "typescript-estree") {
    return Promise.all([import("prettier/plugins/typescript"), import("prettier/plugins/estree")]);
  }
  if (group === "flow-estree") {
    return Promise.all([import("prettier/plugins/flow"), import("prettier/plugins/estree")]);
  }
  if (group === "html") return [await import("prettier/plugins/html")];
  if (group === "postcss") return [await import("prettier/plugins/postcss")];
  if (group === "yaml") return [await import("prettier/plugins/yaml")];
  if (group === "graphql") return [await import("prettier/plugins/graphql")];
  if (group === "markdown") return [await import("prettier/plugins/markdown")];
  return [await import("prettier/plugins/glimmer")];
}

/** Load browser parsers only on demand; source text never leaves the device. */
export async function formatCodeBlock(code: string, language: string): Promise<string> {
  const spec = getFormatterSpec(language);
  if (!spec) throw new CodeBlockFormatError("unsupported");
  if (!code.trim()) return code;
  try {
    // Keep strict JSON validation separate from printing so large number literals and duplicate
    // fields are never parsed and serialized through JavaScript values.
    if (spec.strictJson) JSON.parse(code);
    const prettier = await import("prettier/standalone");
    const plugins = await loadFormatterPlugins(spec.plugins);
    return (await prettier.format(code, {
      parser: spec.parser,
      plugins,
      tabWidth: 2,
      useTabs: false,
      endOfLine: "lf",
      embeddedLanguageFormatting: "off",
    })).replace(/\n$/, "");
  } catch {
    // Parser errors can include source fragments. Show a safe, localized message instead.
    throw new CodeBlockFormatError("invalid");
  }
}
