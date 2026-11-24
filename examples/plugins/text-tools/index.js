// Third-party style editor actions. The host passes only the selected Markdown as input.text
// and inserts the returned { text } in its own editor transaction; no editor object reaches the plugin.
function selectedText(input) {
  const text = input && typeof input.text === "string" ? input.text : "";
  if (!text.trim()) throw new Error("请先选中文本");
  return text;
}

// Inline code, link targets and autolinks keep their case.
const PROTECTED = /(`[^`\n]*`|\]\([^)\n]*\)|<[^>\n]+>)/g;

function upperCase(text) {
  return text.split(PROTECTED).map((part, index) => (index % 2 ? part : part.toUpperCase())).join("");
}

function linesToList(text) {
  return text.split(/\r?\n/)
    .map((line) => line.trim().replace(/^(?:[-*+]|\d+[.)])\s+/, ""))
    .filter(Boolean)
    .map((line) => `- ${line}`)
    .join("\n");
}

function countWords(text) {
  const characters = [...text.replace(/\s/g, "")].length;
  const words = (text.match(/[\p{Script=Han}]|[\p{L}\p{N}]+/gu) || []).length;
  return `共 ${characters} 个字符，约 ${words} 个词`;
}

const MEETING_TEMPLATE = [
  "## 会议纪要",
  "",
  "- 时间：",
  "- 参与人：",
  "",
  "### 讨论要点",
  "",
  "- ",
  "",
  "### 待办",
  "",
  "- 待补充",
].join("\n");

globalThis.__nowenPluginModule = {
  actions: {
    "wrap-quote": ({ input }) => ({ text: `“${selectedText(input)}”` }),
    "upper-case": ({ input }) => ({ text: upperCase(selectedText(input)) }),
    "lines-to-list": ({ input }) => ({ text: linesToList(selectedText(input)) }),
    "count-words": ({ input }) => ({ message: countWords(selectedText(input)) }),
    "meeting-template": () => ({ text: MEETING_TEMPLATE }),
  },
};
