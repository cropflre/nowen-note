const SOURCE_LINE = /^(?:📎[ \t]*)?(?:来源|出处|原文链接|原文|source)[ \t]*[:：][ \t]*(\S.*)$/i;
const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

function excerptCard({ input }) {
  const text = input?.text;
  if (typeof text !== "string" || !text.trim()) throw new Error("请先选中要摘录的文字");

  const lines = text.replace(/\r\n?/g, "\n").trimEnd().split("\n");
  const quote = [];
  let source = "待补充";
  let fence;
  let emptyLines = 0;

  for (const [index, line] of lines.entries()) {
    // An explicit footer supplies attribution. Links in the excerpt stay in place.
    if (!fence && quote.length && index === lines.length - 1) {
      const footer = SOURCE_LINE.exec(line);
      if (footer) {
        source = footer[1];
        break;
      }
    }
    if (line === "") {
      if (quote.length) emptyLines++;
      continue;
    }
    if (emptyLines) {
      const preserveSpacing = fence || /^[ \t]/.test(line);
      quote.push(...Array(preserveSpacing ? emptyLines : 1).fill(">"));
      emptyLines = 0;
    }
    const delimiter = FENCE_LINE.exec(line);
    if (delimiter) {
      const [, marker, rest] = delimiter;
      if (!fence && (marker[0] === "~" || !rest.includes("`"))) fence = marker;
      else if (fence && marker[0] === fence[0] && marker.length >= fence.length && !rest.trim()) fence = undefined;
    }
    quote.push(`> ${line}`);
  }

  return { text: ["**摘录**", "", ...quote, "", `**出处**：${source}`, "", "**我的理解**：", ""].join("\n") };
}

globalThis.__nowenPluginModule = {
  actions: { "excerpt-card": excerptCard },
};
