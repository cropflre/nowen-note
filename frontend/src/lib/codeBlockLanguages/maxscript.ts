import type { LanguageFn } from "lowlight";

const MAXSCRIPT_KEYWORDS = {
  keyword: [
    "about", "across", "and", "animate", "as", "at", "by", "case", "catch", "collect",
    "continue", "coordsys", "do", "else", "exit", "for", "fn", "from", "function", "global",
    "if", "in", "include", "into", "local", "macroscript", "mapped", "max", "not", "of", "off",
    "on", "or", "parameters", "persistent", "plugin", "private", "public", "return", "rollout",
    "set", "struct", "then", "throw", "to", "tool", "try", "utility", "when", "where", "while",
    "with", "xor",
  ].join(" "),
  literal: "true false undefined unsupplied ok dontcollect",
  built_in: [
    "array", "bitarray", "boolean", "box2", "class", "color", "controller", "datapair",
    "dictionary", "double", "eulerangles", "float", "fraction", "framerange", "integer",
    "interval", "matrix3", "mesh", "node", "object", "point2", "point3", "point4", "quat",
    "quaternion", "ray", "string", "symbol", "time", "value",
    "classof", "copy", "deepcopy", "execute", "filein", "format", "getprop", "iskindof", "print",
    "setprop", "superclassof",
  ].join(" "),
};

const maxscript: LanguageFn = (hljs) => {
  const number = {
    className: "number",
    relevance: 0,
    begin: /\b(?:0x[0-9a-f]+|(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)(?:f|s|m|t)?\b/,
  };

  const string = {
    className: "string",
    variants: [
      {
        begin: /@"/,
        end: /"/,
        contains: [{ begin: /""/, relevance: 0 }],
      },
      {
        begin: /"/,
        end: /"/,
        contains: [hljs.BACKSLASH_ESCAPE],
      },
    ],
  };

  const symbol = {
    className: "symbol",
    relevance: 0,
    begin: /#[A-Za-z_][A-Za-z0-9_]*/,
  };

  const nodePath = {
    className: "variable",
    relevance: 0,
    begin: /\$(?:'[^'\r\n]+'|[A-Za-z_*?][A-Za-z0-9_*?]*(?:\/(?:'[^'\r\n]+'|[A-Za-z_*?][A-Za-z0-9_*?]*))*)/,
  };

  return {
    name: "MAXScript",
    aliases: ["ms", "mcr"],
    case_insensitive: true,
    // MAXScript is intentionally explicit-only. Registering it must not change the existing
    // `auto` language detection results for ordinary code blocks.
    disableAutodetect: true,
    keywords: MAXSCRIPT_KEYWORDS,
    contains: [
      hljs.COMMENT(/--/, /$/, { relevance: 0 }),
      hljs.COMMENT(/\/\*/, /\*\//, { relevance: 0 }),
      {
        match: [/\b(?:fn|function)\b/, /\s+/, /[A-Za-z_][A-Za-z0-9_]*/],
        scope: { 1: "keyword", 3: "title.function" },
      },
      {
        match: [/\b(?:struct|rollout|utility|macroscript|plugin)\b/, /\s+/, /[A-Za-z_][A-Za-z0-9_]*/],
        scope: { 1: "keyword", 3: "title.class" },
      },
      string,
      {
        className: "literal",
        begin: /#\{/,
        end: /\}/,
        contains: [number],
      },
      symbol,
      nodePath,
      number,
    ],
  };
};

export default maxscript;
