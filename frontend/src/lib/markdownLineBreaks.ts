/**
 * 把段落里的单个换行渲染成 <br>，效果等同 marked / markdown-it 的 `breaks: true`。
 *
 * CommonMark 把段落内的单个换行当作 soft break，浏览器会把它折叠成一个空格，
 * 于是预览 / 阅读 / 分享页里源码栏看得到的换行全部"并在一块"。这里把 text 节点里的换行
 * 拆成 `break` 节点，由 mdast-util-to-hast 输出 <br>。
 *
 * - 只处理 text 节点：围栏 / 缩进代码块、行内代码、raw HTML 块的内容不是 text 节点，不受影响。
 * - 要排在 remarkSiyuanCallouts 之后：Callout 先从原始文本里读出标记行，再回写正文。
 * - 紧跟在手写 `<br>` 后面的换行不再补 <br>，否则 `行尾<br>` 加换行这种常见写法会多出一个空行。
 */
type MarkdownNode = {
  type?: string;
  value?: string;
  children?: MarkdownNode[];
};

const LINE_ENDING_RE = /\r\n|\n|\r/;
const INLINE_BR_RE = /^<br\s*\/?>$/i;

function preserveLineBreaks(parent: MarkdownNode): void {
  if (!parent.children) return;
  const next: MarkdownNode[] = [];
  for (const child of parent.children) {
    if (child.type !== "text" || !LINE_ENDING_RE.test(child.value || "")) {
      preserveLineBreaks(child);
      next.push(child);
      continue;
    }
    const previous = next[next.length - 1];
    const lines = (child.value || "").split(LINE_ENDING_RE);
    lines.forEach((line, index) => {
      const brAlreadyBroke = index === 1 && !lines[0].trim()
        && previous?.type === "html" && INLINE_BR_RE.test(previous.value || "");
      if (index > 0 && !brAlreadyBroke) next.push({ type: "break" });
      if (line) next.push({ type: "text", value: line });
    });
  }
  parent.children = next;
}

export function remarkPreserveLineBreaks() {
  return (tree: MarkdownNode) => preserveLineBreaks(tree);
}
