/**
 * Markdown 语法增强扩展集
 *
 * 目的：把 markdown.com.cn cheat-sheet 上常见的"内联标记 + 粘贴整段 markdown"两类
 * 体验补齐。原始 StarterKit / Highlight / Underline 扩展只提供节点/快捷键，
 * 但**没有自动把 `~~xx~~` `==xx==` 转成对应 mark 的 input rule**，更没有
 * "粘贴一段 markdown 文本时自动结构化"的能力。这里集中补这两块，避免散落到
 * 主编辑器文件里。
 *
 * 暴露：
 *   - StrikeMarkdownRules：删除线 `~~text~~` input/paste rule
 *   - HighlightMarkdownRules：高亮 `==text==` input/paste rule
 *   - BilibiliVideoPasteHandler：粘贴独立 B 站视频 URL 时直接插入视频节点
 *   - MarkdownPasteHandler：纯文本粘贴时检测是否是 markdown，是的话用项目里
 *       已经装好的 `marked` 渲染成 HTML 再让 ProseMirror 走 HTML 解析路径，
 *       直接得到结构化文档（标题/列表/表格/链接 等）。
 *
 * 故意不做的事：
 *   - 不引入新依赖（marked、turndown 已在 frontend/package.json）
 *   - 不新增脚注/定义列表/emoji 等节点：项目自研的 lezer GFM 渲染端不识别这些
 *     节点，加了之后预览/分享页会塌，得不偿失。
 */
import { Extension } from "@tiptap/react";
import { markInputRule, markPasteRule, InputRule } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { parseVideoUrl } from "@/components/VideoExtension";
import { markdownToHtml } from "@/lib/contentFormat";
import { sanitizeForPaste } from "@/lib/sanitizeHtml";

/* -------------------------------------------------------------------------- */
/*  内联 mark 的 input / paste rule                                           */
/* -------------------------------------------------------------------------- */

// 删除线：`~~xxx~~`
// 不能与 `~text~` 冲突（部分 MD 方言用单 `~` 表示删除线，但项目 turndown 序列化
// 用 `~~` 双波浪号，这里只匹配双 `~~` 即可，避免把数学公式 / 文件名误当成删除线）
const STRIKE_INPUT = /(?:^|\s)(~~([^~]+)~~)$/;
const STRIKE_PASTE = /(?:^|\s)(~~([^~]+)~~)/g;

export const StrikeMarkdownRules = Extension.create({
  name: "strikeMarkdownRules",
  addInputRules() {
    const type = this.editor.schema.marks.strike;
    if (!type) return [];
    return [markInputRule({ find: STRIKE_INPUT, type })];
  },
  addPasteRules() {
    const type = this.editor.schema.marks.strike;
    if (!type) return [];
    return [markPasteRule({ find: STRIKE_PASTE, type })];
  },
});

// 高亮：`==xxx==`
// 注意：== 在某些代码片段（Python 比较、C 等于）里也会出现，所以仅在前后是边界
// （行首/空白）时触发 input rule，避免在写代码时被误转。
const HIGHLIGHT_INPUT = /(?:^|\s)(==([^=]+)==)$/;
const HIGHLIGHT_PASTE = /(?:^|\s)(==([^=]+)==)/g;

export const HighlightMarkdownRules = Extension.create({
  name: "highlightMarkdownRules",
  addInputRules() {
    const type = this.editor.schema.marks.highlight;
    if (!type) return [];
    return [markInputRule({ find: HIGHLIGHT_INPUT, type })];
  },
  addPasteRules() {
    const type = this.editor.schema.marks.highlight;
    if (!type) return [];
    return [markPasteRule({ find: HIGHLIGHT_PASTE, type })];
  },
});

/* -------------------------------------------------------------------------- */
/*  Markdown 链接：`[文本](url "title")` input rule                             */
/* -------------------------------------------------------------------------- */

/**
 * 匹配 `[text](url "可选 title")`，触发字符是收尾的 `)`。
 *
 * 设计取舍：
 *   - 文本部分 `[^\]]+` 禁止再嵌 `]`，避免嵌套时贪婪吞段
 *   - URL 部分 `\S+` 不允许空格（用空格做天然分隔，规避把后面整段抓进来）
 *   - 标题部分可选，必须用双引号包裹（markdown.com.cn 标准写法）
 *   - 整体放在 `(?:^|[^!])` 后面，确保前一个字符不是 `!`，否则会劫持图片语法
 *     `![alt](url)`。捕获组 1 是前导字符（用作起点修正），2 文字、3 URL、4 title
 *   - 末尾 `$` 要求是输入行尾——这是 input rule 的常态（边打边匹配）
 *
 * 替换逻辑：把整段 `[a](u "t")` 替换为 `a` 文本节点 + link mark。
 */
const LINK_INPUT = /(?:^|[^!])(\[([^\]]+)\]\((\S+?)(?:\s+"([^"]*)")?\))$/;

export const LinkMarkdownRule = Extension.create({
  name: "linkMarkdownRule",
  addInputRules() {
    const type = this.editor.schema.marks.link;
    if (!type) return [];
    return [
      new InputRule({
        find: LINK_INPUT,
        handler: ({ state, range, match }) => {
          const full = match[1];        // `[text](url "title")`
          const text = match[2];        // text
          const href = match[3];        // url
          const title = match[4] ?? null; // title 可选

          if (!full || !text || !href) return null;

          // 起点修正：match[0] 可能比 match[1] 多 1 个前导字符（非 `!` 的那个）
          const fullStart = range.to - full.length;

          const linkMark = type.create({ href, title });
          const tr = state.tr;
          tr.replaceWith(
            fullStart,
            range.to,
            state.schema.text(text, [linkMark]),
          );
          // 关键：替换完成后让光标落在新链接 mark 之外，避免接着输入还在 link 里
          tr.removeStoredMark(type);
        },
      }),
    ];
  },
});

/* -------------------------------------------------------------------------- */
/*  Markdown 任务列表：行首 `- [ ] ` / `- [x] ` 自动转 taskList                */
/* -------------------------------------------------------------------------- */

/**
 * 任务列表自动转换：覆盖两种触发场景
 *
 * 场景 1：顶层空段落输入完整 `- [x] `（少见，多为粘贴）
 * 场景 2（关键）：先输 `- ` 被 BulletList 转成 ul>li>p，再输 `[x] `
 *   把整个 bulletList 升级为 taskList，所有 li 升级为 taskItem。
 *
 * 实现方式：用 `appendTransaction` 而非 input rule。
 * 原因：在 ul>li>p 里，input rule 的触发被 prosemirror-inputrules 内部
 * 的某些条件拦截掉了（实际验证 InputRule 在 listItem 内不可靠），
 * 改成基于文档变化扫描的方式更鲁棒，对 IME / 粘贴 / 中文输入都通用。
 *
 * 性能：appendTransaction 只在 docChanged 时跑，且只扫"刚改动的范围"
 * （tr.steps 的 mapping），开销 O(改动节点数)。
 *
 * `[x]` / `[X]` 都接受（GFM 兼容）。
 */
const TASK_PREFIX = /^(\[([ xX])\])\s+/;

export const TaskListMarkdownRule = Extension.create({
  name: "taskListMarkdownRule",
  addProseMirrorPlugins() {
    const editor = this.editor;
    return [
      new Plugin({
        key: new PluginKey("taskListAutoConvert"),
        appendTransaction: (transactions, _oldState, newState) => {
          if (!transactions.some((tr) => tr.docChanged)) return null;

          const schema = newState.schema;
          const taskListType = schema.nodes.taskList;
          const taskItemType = schema.nodes.taskItem;
          const paragraphType = schema.nodes.paragraph;
          const bulletListType = schema.nodes.bulletList;
          const listItemType = schema.nodes.listItem;
          if (!taskListType || !taskItemType || !paragraphType) return null;

          // 找当前光标所在 paragraph，看它是否以 `[x] ` / `[ ] ` 起头。
          // 只处理光标处的段落，避免误改其它内容；用户连续输入时每次
          // 检查一次，足够覆盖"打到空格那一瞬间触发"的体验。
          const sel = newState.selection;
          if (!sel.empty) return null;
          const $pos = sel.$from;
          if ($pos.parent.type !== paragraphType) return null;
          const text = $pos.parent.textContent;
          const m = TASK_PREFIX.exec(text);
          if (!m) return null;
          const checked = m[2] === "x" || m[2] === "X";
          const prefixLen = m[0].length; // 含末尾空格

          let tr = newState.tr;

          // 场景 2：在 bulletList > listItem > paragraph 内
          if (
            bulletListType
            && listItemType
            && $pos.depth >= 3
            && $pos.node($pos.depth - 1).type === listItemType
            && $pos.node($pos.depth - 2).type === bulletListType
          ) {
            const li = $pos.node($pos.depth - 1);
            // 只在当前 li 的第一个 paragraph 触发，避免 li 里嵌套段落被误触
            if (li.firstChild !== $pos.parent) return null;

            const ul = $pos.node($pos.depth - 2);
            const ulStart = $pos.before($pos.depth - 2);
            const liIndex = $pos.index($pos.depth - 2);

            const newItems: any[] = [];
            ul.forEach((child, _offset, idx) => {
              if (child.type !== listItemType) return;
              if (idx === liIndex) {
                // 当前 li：剥掉 `[x] ` 前缀，用剩余内容构造 taskItem
                const firstP = child.firstChild;
                if (!firstP || firstP.type !== paragraphType) {
                  newItems.push(taskItemType.create({ checked }, child.content));
                  return;
                }
                // 用 ProseMirror 的 sliceContent 直接切：firstP 内 prefixLen 之后的全部 inline
                const remaining = firstP.content.cut(prefixLen);
                const newP = paragraphType.create(null, remaining);
                // 拼上 li 里 firstP 之后的兄弟（嵌套 list 等）
                const tail: any[] = [];
                child.content.forEach((c, _o, i) => {
                  if (i > 0) tail.push(c);
                });
                newItems.push(taskItemType.create({ checked }, [newP, ...tail]));
              } else {
                newItems.push(taskItemType.create({ checked: false }, child.content));
              }
            });

            if (newItems.length === 0) return null;
            const newTaskList = taskListType.create(null, newItems);
            tr = tr.replaceWith(ulStart, ulStart + ul.nodeSize, newTaskList);

            // 把光标放到当前 taskItem 的 paragraph 末尾
            // 新结构：taskList(start=ulStart) > taskItem[liIndex] > paragraph
            // 计算光标位置：ulStart + 1(进 taskList) + sum(前面 taskItem.nodeSize) + 1(进 taskItem) + 1(进 paragraph) + remaining.size
            let cursorPos = ulStart + 1;
            for (let i = 0; i < liIndex; i++) cursorPos += newItems[i].nodeSize;
            cursorPos += 2; // 进 taskItem + 进 paragraph
            const remainingSize = (newItems[liIndex] as any).firstChild?.content.size ?? 0;
            cursorPos += remainingSize;
            tr = tr.setSelection(
              (newState.selection.constructor as any).near(tr.doc.resolve(cursorPos)),
            );
            return tr;
          }

          // 场景 1：顶层 paragraph
          if ($pos.depth === 1) {
            const pStart = $pos.before(1);
            const pEnd = $pos.after(1);
            const remaining = $pos.parent.content.cut(prefixLen);
            const newP = paragraphType.create(null, remaining);
            const newTaskList = taskListType.create(
              null,
              taskItemType.create({ checked }, newP),
            );
            tr = tr.replaceWith(pStart, pEnd, newTaskList);
            // 光标放到 taskItem 内段落末尾
            const cursorPos = pStart + 3 + remaining.size;
            tr = tr.setSelection(
              (newState.selection.constructor as any).near(tr.doc.resolve(cursorPos)),
            );
            return tr;
          }

          return null;
        },
      }),
    ];
  },
});

/* -------------------------------------------------------------------------- */
/*  B 站视频链接粘贴：独立 URL → video 节点                                    */
/* -------------------------------------------------------------------------- */

export type BilibiliVideoPasteAttrs = {
  src: string;
  platform: "bilibili";
  kind: "iframe";
  originalUrl: string;
};

/**
 * 只识别剪贴板中“独立存在”的 B 站视频地址。
 *
 * 这样既能覆盖从浏览器地址栏复制 BV/av 链接的主要场景，又不会把文章中的 URL、
 * Markdown 链接、代码块内容或替换选中文字的普通粘贴行为意外转换成视频节点。
 */
export function parseStandaloneBilibiliVideoPaste(text: string): BilibiliVideoPasteAttrs | null {
  const originalUrl = (text || "").trim();
  if (!originalUrl || /\s/.test(originalUrl)) return null;

  const parsed = parseVideoUrl(originalUrl);
  if (!parsed || parsed.platform !== "bilibili" || parsed.kind !== "iframe") return null;

  return {
    src: parsed.embedUrl,
    platform: "bilibili",
    kind: "iframe",
    originalUrl,
  };
}

const BILIBILI_VIDEO_PASTE_KEY = new PluginKey("bilibiliVideoPaste");

export const BilibiliVideoPasteHandler = Extension.create({
  name: "bilibiliVideoPaste",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: BILIBILI_VIDEO_PASTE_KEY,
        props: {
          // TiptapEditor 自己定义了 handlePaste，并且始终接管普通粘贴，因此这里必须在
          // DOM paste 阶段优先识别视频链接，不能使用会被 editorProps 覆盖的 handlePaste。
          handleDOMEvents: {
            paste: (view, rawEvent) => {
              const event = rawEvent as ClipboardEvent;
              const clipboard = event.clipboardData;
              if (!clipboard || !view.editable) return false;

              const selection = view.state.selection;
              if (!selection.empty || selection.$from.parent.type.spec.code) return false;

              const text = clipboard.getData("text/plain") || clipboard.getData("text/uri-list");
              const attrs = parseStandaloneBilibiliVideoPaste(text);
              if (!attrs) return false;

              const videoType = view.state.schema.nodes.video;
              if (!videoType) return false;

              try {
                const videoNode = videoType.create(attrs);
                const transaction = view.state.tr
                  .replaceSelectionWith(videoNode, false)
                  .scrollIntoView();
                view.dispatch(transaction);
                event.preventDefault();
                return true;
              } catch (error) {
                console.warn("[bilibili-video-paste] insert failed", error);
                return false;
              }
            },
          },
        },
      }),
    ];
  },
});

/* -------------------------------------------------------------------------- */
/*  Markdown 粘贴：纯文本 → HTML → ProseMirror                                */
/* -------------------------------------------------------------------------- */

/**
 * 启发式判断一段纯文本是不是"足够 markdown"，避免把每段普通文本都按 MD 渲染。
 *
 * 判定为 markdown 的特征（命中任一即可）：
 *   - ATX 标题：行首 `# ` ~ `###### `
 *   - 围栏代码块：``` 或 ~~~
 *   - 列表项：行首 `- `、`* `、`+ `、`1. `
 *   - 引用：行首 `> `
 *   - 表格：包含 `| ... |` 至少 2 行 + 一行分隔 `| --- |`
 *   - 链接/图片：`[txt](url)` `![alt](url)`
 *   - 任务列表：`- [ ]` / `- [x]`
 *   - 行内代码 + 至少一个换行（避免单行 `code` 误判）
 */
function looksLikeMarkdown(text: string): boolean {
  if (!text || text.length < 3) return false;
  // 太短的纯单行链接/图片也算
  if (/!\[[^\]]*\]\([^)]+\)/.test(text)) return true; // 图片
  if (/\[[^\]]+\]\([^)]+\)/.test(text)) return true;  // 链接

  const lines = text.split(/\r?\n/);
  if (lines.length === 1) {
    // 单行：除非是纯链接/图片（上面已处理），否则不当 MD
    return false;
  }

  let signalCount = 0;
  let inFence = false;
  let tableHeader = false;
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    const trimmed = ln.trim();
    if (/^(```|~~~)/.test(trimmed)) {
      inFence = !inFence;
      signalCount += 2; // 围栏代码块是强信号
      continue;
    }
    if (inFence) continue;

    if (/^#{1,6}\s+\S/.test(trimmed)) signalCount += 2;            // 标题
    else if (/^>\s+\S/.test(trimmed)) signalCount++;                // 引用
    else if (/^[-*+]\s+\S/.test(trimmed)) signalCount++;            // 列表
    else if (/^\d+\.\s+\S/.test(trimmed)) signalCount++;            // 有序列表
    else if (/^[-*+]\s+\[[ xX]\]\s+/.test(trimmed)) signalCount += 2; // 任务
    else if (/^---+$|^\*\*\*+$/.test(trimmed)) signalCount++;       // 分隔线
    else if (/\*\*[^*]+\*\*|__[^_]+__/.test(trimmed)) signalCount++; // 粗体
    else if (/`[^`\n]+`/.test(trimmed)) signalCount++;              // 行内代码

    // 表格：连续两行都有 `|`，且第二行像 `|---|---|`
    if (trimmed.startsWith("|") && trimmed.endsWith("|")) {
      if (tableHeader && /^\|\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|$/.test(trimmed)) {
        signalCount += 3;
      }
      tableHeader = true;
    } else {
      tableHeader = false;
    }
  }

  // 多行文本里至少 2 个 markdown 信号才认定为 MD
  return signalCount >= 2;
}

/**
 * 粘贴增强：监听 `paste` 事件
 *   - 如果剪贴板已经有 HTML（ProseMirror 自己会处理，不干预）
 *   - 如果只有 text/plain，且内容看起来是 markdown，就用 marked 渲染成 HTML，
 *     再以 HTML 形式塞回 ProseMirror，让其按结构化方式解析。
 *
 * 这条策略让 cheat-sheet 上任何片段一贴就成形（标题/表格/任务/链接 全部还原）。
 */
const MARKDOWN_PASTE_KEY = new PluginKey("markdownPaste");

export const MarkdownPasteHandler = Extension.create({
  name: "markdownPaste",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: MARKDOWN_PASTE_KEY,
        props: {
          handlePaste: (view, event) => {
            const cb = event.clipboardData;
            if (!cb) return false;

            const html = cb.getData("text/html");
            // 已有 HTML，且不是某些浏览器的"只是把纯文本包了一层 <html>"骗局
            // → 让 ProseMirror 走默认 HTML 路径
            if (html && /<\w+[\s>]/.test(html)) return false;

            const text = cb.getData("text/plain");
            if (!text || !looksLikeMarkdown(text)) return false;

            // 关键步骤：复用项目已有的 markdownToHtml（基于 marked + GFM），
            // 转成 HTML 后让 PM 解析。这样表格、任务列表、代码块、链接全都能还原。
            let rendered: string;
            try {
              rendered = markdownToHtml(text);
            } catch {
              return false;
            }
            if (!rendered) return false;

            // SEC-XSS-01-D: marked 输出清洗，防止 markdown 中嵌入的 XSS
            const sanitized = sanitizeForPaste(rendered);

            // 用一个临时容器解析 HTML，再用 ProseMirror 的 clipboardParser 走标准
            // 路径，避免直接 insertContent(html) 在某些 schema 下丢失节点属性。
            const dom = document.createElement("div");
            dom.innerHTML = sanitized;

            const slice = (view.props as any).clipboardParser
              ? (view.props as any).clipboardParser.parseSlice(dom, { preserveWhitespace: false })
              : view.someProp("clipboardParser", (parser: any) =>
                  parser.parseSlice(dom, { preserveWhitespace: false })
                );

            if (!slice) return false;

            const tr = view.state.tr.replaceSelection(slice).scrollIntoView();
            view.dispatch(tr);
            event.preventDefault();
            return true;
          },
        },
      }),
    ];
  },
});

/* -------------------------------------------------------------------------- */
/*  打包导出                                                                  */
/* -------------------------------------------------------------------------- */

export const MarkdownEnhancements = [
  StrikeMarkdownRules,
  HighlightMarkdownRules,
  LinkMarkdownRule,
  TaskListMarkdownRule,
  BilibiliVideoPasteHandler,
  MarkdownPasteHandler,
];
