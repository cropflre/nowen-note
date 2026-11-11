// AI actions in this pack are Prompt Packs that the host runs with the user's AI configuration,
// so this code never sees their text. The one executable action is a local, deterministic cleanup.
function tidyWhitespace(text) {
  return text
    .split(/\r?\n/)
    // Keep list/quote indentation; only collapse runs of spaces after the first visible character.
    .map((line) => line.replace(/^(\s*)(.*?)\s*$/, (_all, indent, body) => indent + body.replace(/[ \t]{2,}/g, " ")))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

globalThis.__nowenPluginModule = {
  actions: {
    "tidy-whitespace": ({ input }) => {
      const text = input && typeof input.text === "string" ? input.text : "";
      if (!text.trim()) throw new Error("请先选中文本");
      return { text: tidyWhitespace(text) };
    },
  },
};
