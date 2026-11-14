/**
 * README 截图用的演示数据。
 *
 * 说明：
 * - 只通过 Nowen Note 自身的公开 HTTP API 写入，不改动业务逻辑与数据库结构；
 * - 内容为虚构的产品演示文案，不含任何真实笔记、密钥或个人信息；
 * - 通过「笔记本 / 笔记标题」判断是否已存在，可重复执行（幂等）。
 */

const text = (value, marks) => ({ type: "text", text: value, ...(marks ? { marks } : {}) });
const paragraph = (...content) => ({
  type: "paragraph",
  content: content.map((item) => (typeof item === "string" ? text(item) : item)),
});
const heading = (level, value) => ({ type: "heading", attrs: { level }, content: [text(value)] });
const listItem = (...content) => ({ type: "listItem", content: [paragraph(...content)] });
const bulletList = (...items) => ({ type: "bulletList", content: items.map((item) => listItem(...item)) });
const taskItem = (checked, value) => ({ type: "taskItem", attrs: { checked }, content: [paragraph(value)] });
const taskList = (...items) => ({ type: "taskList", content: items });
const blockquote = (value) => ({ type: "blockquote", content: [paragraph(value)] });
const codeBlock = (language, value) => ({
  type: "codeBlock",
  attrs: { language },
  content: [text(value)],
});
const tableCell = (type, value) => ({ type, content: [paragraph(value)] });
const table = (rows) => ({
  type: "table",
  content: rows.map((row, rowIndex) => ({
    type: "tableRow",
    content: row.map((value) => tableCell(rowIndex === 0 ? "tableHeader" : "tableCell", value)),
  })),
});

const richReviewDoc = {
  type: "doc",
  content: [
    paragraph("这次评审聚焦 v1.6 的三个体验问题：移动端导航、Markdown 预览一致性，以及 AI 提案的确认流程。"),
    heading(2, "评审结论"),
    paragraph(
      text("移动端侧边栏遮挡", [{ type: "bold" }]),
      " 定为阻塞项，必须在发版前修复；其余两项进入下个迭代。",
    ),
    bulletList(
      ["侧边栏在 390px 宽度下会盖住正文首行，改为浮层抽屉"],
      ["Markdown 预览与富文本的字号、行距统一到同一套排版变量"],
      ["AI 提案默认展示差异，确认后才写入正文"],
    ),
    heading(2, "排期"),
    taskList(
      taskItem(true, "交互稿评审"),
      taskItem(true, "同步冲突面板方案"),
      taskItem(false, "修复移动端侧边栏遮挡"),
      taskItem(false, "补齐 Markdown 表格回归用例"),
    ),
    blockquote("原则：发版前只修阻塞问题，新需求一律进下个迭代。"),
    heading(2, "接口约定"),
    codeBlock("ts", "type ReviewResult = {\n  blocking: string[]\n  deferred: string[]\n}"),
    heading(2, "验收标准"),
    table([
      ["场景", "期望", "负责人"],
      ["390px 宽度打开侧边栏", "正文不被遮挡", "前端"],
      ["切换 Markdown 预览", "字号与富文本一致", "设计"],
    ]),
  ],
};

export const demoNotebooks = [
  { key: "kb", name: "我的知识库", icon: "📚", sortOrder: 0 },
  { key: "dev", name: "开发项目", icon: "💻", parent: "kb", sortOrder: 0 },
  { key: "design", name: "产品设计", icon: "🎨", parent: "kb", sortOrder: 1 },
];

export const demoNotes = [
  {
    title: "Nowen Note v1.6 产品路线图",
    notebook: "design",
    format: "markdown",
    pinned: true,
    tags: ["产品"],
    body: `> 目标：把「知识树 + 编辑器 + AI」打磨成一条顺畅的个人知识工作流，让整理和写作都更轻。

## 版本目标

- **知识树**：多层文件夹、拖拽排序与批量移动
- **编辑器**：Markdown 分屏实时预览，表格与代码块体验对齐富文本
- **AI**：问答上下文可精确到笔记本范围，写作助手支持选中改写
- **多端**：Web / 桌面 / Android 三端同步，冲突状态可视化

## 里程碑

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| M1 | 知识树层级与排序重构 | 已完成 |
| M2 | Markdown 分屏与图片粘贴 | 已完成 |
| M3 | AI 写作助手与模型配置 | 进行中 |
| M4 | 同步冲突面板 | 计划中 |

## 风险与对策

1. 大文档渲染性能 —— 引入虚拟滚动，先压测 5 万字笔记
2. 同步冲突语义 —— 保留双端正文，冲突面板交由用户确认

## 本周待办

- [x] 整理知识树交互稿
- [ ] 补齐 Markdown 表格用例
- [ ] 压测 2 万段落文档
`,
  },
  {
    title: "编辑器交互规范",
    notebook: "design",
    tags: ["产品"],
    body: `这份规范用于统一桌面端与移动端的编辑器行为，避免同类操作在不同端出现两套逻辑。

## 设计原则

1. **写作为主**：所有面板都能收起，正文永远是视觉重心
2. **就地操作**：重命名、移动、打标签都在原地完成，不跳新页面
3. **即时反馈**：保存与同步状态常驻底部，不打断输入

## 快捷键

| 操作 | macOS | Windows |
| --- | --- | --- |
| 新建笔记 | ⌘ N | Ctrl N |
| 全局搜索 | ⌘ K | Ctrl K |
| 切换编辑模式 | ⌘ ⇧ M | Ctrl Shift M |
| 保存 | ⌘ S | Ctrl S |

## 状态与提示

- 保存中：底部显示「保存中…」，超过 1 秒才出现
- 已保存：显示时间戳，不弹 Toast
- 冲突：右上角出现横幅，点击进入对比

## 空状态

列表为空时给出下一步动作，而不是一句「暂无数据」。
`,
  },
  {
    title: "Sprint 25 需求评审",
    notebook: "design",
    format: "tiptap",
    tags: ["产品"],
    content: JSON.stringify(richReviewDoc),
  },
  {
    title: "AI 应用开发笔记",
    notebook: "dev",
    tags: ["技术"],
    body: `把大模型接进笔记应用，难点不在调用，而在「上下文从哪来、结果怎么信」。

## RAG 的三段式

1. **切分**：按标题层级切块，保留父级路径
2. **召回**：向量检索 + 关键词 BM25 混合排序
3. **生成**：命中段落带来源一起交给模型作答

## 最小可用的检索代码

\`\`\`ts
const chunks = splitByHeading(markdown, { maxTokens: 400 })
const vectors = await embed(chunks.map((c) => c.text))
const hits = topK(vectors, await embed(question), 8)
const answer = await chat({ question, context: hits })
\`\`\`

## 评估指标

| 指标 | 含义 | 目标 |
| --- | --- | --- |
| 召回率 | 正确答案是否被检索到 | > 90% |
| 引用准确率 | 回答是否来自原文 | > 95% |
| 首字延迟 | 用户感知的等待时长 | < 1.5s |

## 踩过的坑

- 表格被切断后语义丢失，改为整表保留
- 中文标点影响分词，建索引前先做归一化

> 结论：先把检索做对，再谈提示词。
`,
  },
  {
    title: "Markdown 使用指南",
    notebook: "dev",
    tags: ["技术"],
    body: `Nowen Note 的 Markdown 笔记支持实时预览与分屏写作，下面是最常用的一组语法。

## 基础语法

- **加粗**、*斜体*、~~删除线~~ 与 \`行内代码\`
- 有序列表、无序列表、引用块和分割线
- 三级标题、脚注与任务清单

## 任务清单

- [x] 建立「开发项目」笔记本
- [x] 把会议纪要迁进知识树
- [ ] 给常用笔记加上标签

## 表格与代码

| 语法 | 写法 | 效果 |
| --- | --- | --- |
| 标题 | \`## 二级标题\` | 章节结构 |
| 引用 | \`> 一段话\` | 强调观点 |
| 代码 | 三个反引号 | 语法高亮 |

\`\`\`ts
export function greeting(name: string) {
  return \`你好，\${name}\`
}
\`\`\`

## 更多

> 提示：正常输入会自动保存，也可以按 ⌘S / Ctrl+S 手动保存。

- 双链写法：\`[[笔记标题]]\`
- 附件与图片直接粘贴进正文即可
`,
  },
  {
    title: "双周迭代复盘（Sprint 24）",
    notebook: "dev",
    tags: ["复盘"],
    body: `Sprint 24 覆盖知识树重构与 AI 写作助手，下面是本期的交付、数据与复盘结论。

## 本期交付

- 知识树批量移动与跨笔记本拖拽
- Markdown 分屏预览、滚动同步
- AI 写作助手上线「选中改写」

## 关键数据

| 指标 | 上期 | 本期 |
| --- | --- | --- |
| 周活用户 | 1,240 | 1,486 |
| 人均笔记数 | 38 | 45 |
| 崩溃率 | 0.21% | 0.09% |

## 做得好的

1. 需求拆分更细，单卡工作量不超过 2 天
2. 编辑器回归用例从 42 条补到 68 条

## 待改进

- 联调阶段接口变更缺少通知
- 发布前的手工验收仍依赖个人经验

## 下期重点

- [ ] 同步冲突面板
- [ ] 附件上传断点续传
`,
  },
  {
    title: "今日任务",
    notebook: "kb",
    tags: ["产品"],
    body: `- [x] 整理 v1.6 需求清单
- [x] 评审 Markdown 表格样式
- [ ] 修复移动端侧边栏遮挡
- [ ] 和设计对齐 AI 面板间距
- [ ] 输出本周迭代周报

## 备注

优先处理移动端遮挡问题，其余任务顺延到明天上午。
`,
  },
];

export const demoTags = [
  { name: "产品", color: "#6366f1" },
  { name: "技术", color: "#0ea5e9" },
  { name: "复盘", color: "#f59e0b" },
];

export const demoTasks = [
  { title: "评审 v1.6 编辑器交互稿", priority: 1, dueOffset: 0, status: "doing" },
  { title: "修复移动端侧边栏遮挡", priority: 1, dueOffset: 0, status: "todo" },
  { title: "补齐 Markdown 表格回归用例", priority: 2, dueOffset: 1, status: "todo" },
  { title: "压测 2 万段落文档渲染", priority: 2, dueOffset: 2, status: "todo" },
  { title: "同步冲突面板设计评审", priority: 1, dueOffset: 4, status: "blocked" },
  { title: "输出双周迭代周报", priority: 3, dueOffset: 3, status: "done" },
  { title: "整理 AI 问答上下文来源说明", priority: 2, dueOffset: -1, status: "done" },
  { title: "升级依赖并跑全量回归", priority: 3, dueOffset: -2, status: "done" },
];

const isoDate = (offset) => {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  return date.toISOString().slice(0, 10);
};

async function request(baseUrl, path, { token, method = "GET", body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const raw = await response.text();
  let payload = null;
  try {
    payload = raw ? JSON.parse(raw) : null;
  } catch {
    payload = raw;
  }
  if (!response.ok) {
    const error = new Error(`${method} ${path} -> ${response.status}: ${String(raw).slice(0, 180)}`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

export async function loginOrRegister({ baseUrl, username, password }) {
  try {
    const session = await request(baseUrl, "/api/auth/login", {
      method: "POST",
      body: { username, password },
    });
    return session.token;
  } catch (error) {
    if (![400, 401, 403].includes(error.status)) throw error;
  }

  await request(baseUrl, "/api/auth/register", {
    method: "POST",
    body: {
      username,
      password,
      displayName: "知远",
      email: `${username}@nowen.local`,
    },
  });
  const session = await request(baseUrl, "/api/auth/login", {
    method: "POST",
    body: { username, password },
  });
  return session.token;
}

/**
 * 整理笔记本顺序：把演示用的「我的知识库」排在官方指南前面。
 *
 * 官方指南由首次登录引导创建（sortOrder = -1000），默认会压在最上面，
 * 截图里会挤掉演示内容。这里只调整演示账号自己的排序，不改内容。
 */
export async function arrangeDemoNotebooks({ baseUrl, token, log = console.log }) {
  const notebooks = await request(baseUrl, "/api/notebooks", { token });
  for (const notebook of notebooks) {
    if (notebook.name.includes("使用指南")) {
      await request(baseUrl, `/api/notebooks/${notebook.id}`, {
        token,
        method: "PUT",
        body: { sortOrder: 100, isExpanded: 0 },
      }).catch(() => {});
    }
    if (notebook.name === "我的知识库") {
      await request(baseUrl, `/api/notebooks/${notebook.id}`, {
        token,
        method: "PUT",
        body: { sortOrder: -2000, isExpanded: 1 },
      }).catch(() => {});
    }
  }
  log("[data] 已调整笔记本顺序（演示知识库优先）");
}

export async function seedDemoWorkspace({ baseUrl, token, log = console.log }) {  const notebooks = await request(baseUrl, "/api/notebooks", { token });
  const byName = new Map(notebooks.map((item) => [item.name, item]));
  const notebookIds = {};

  for (const spec of demoNotebooks) {
    const found = byName.get(spec.name);
    if (found) {
      notebookIds[spec.key] = found.id;
      continue;
    }
    const created = await request(baseUrl, "/api/notebooks", {
      token,
      method: "POST",
      body: {
        name: spec.name,
        icon: spec.icon,
        sortOrder: spec.sortOrder ?? 0,
        ...(spec.parent ? { parentId: notebookIds[spec.parent] } : {}),
      },
    });
    notebookIds[spec.key] = created.id;
    log(`[data] 新建笔记本「${spec.name}」`);
  }

  const allNotes = await request(baseUrl, "/api/notes?limit=500", { token }).catch(() => null);
  const listed = Array.isArray(allNotes) ? allNotes : allNotes?.notes || [];
  const noteByTitle = new Map(listed.map((note) => [note.title, note]));

  for (const spec of demoNotes) {
    if (noteByTitle.has(spec.title)) continue;
    const created = await request(baseUrl, "/api/notes", {
      token,
      method: "POST",
      body: {
        notebookId: notebookIds[spec.notebook],
        title: spec.title,
        content: spec.body ?? spec.content,
        contentFormat: spec.format === "tiptap" ? "tiptap-json" : "markdown",
      },
    });
    noteByTitle.set(spec.title, created);
    log(`[data] 新建笔记「${spec.title}」`);
  }

  const tags = await request(baseUrl, "/api/tags", { token });
  const tagByName = new Map(tags.map((tag) => [tag.name, tag]));

  for (const spec of demoTags) {
    if (tagByName.has(spec.name)) continue;
    const created = await request(baseUrl, "/api/tags", {
      token,
      method: "POST",
      body: { name: spec.name, color: spec.color },
    });
    tagByName.set(spec.name, created);
    log(`[data] 新建标签「${spec.name}」`);
  }

  for (const spec of demoNotes) {
    const note = noteByTitle.get(spec.title);
    if (!note) continue;
    for (const tagName of spec.tags || []) {
      const tag = tagByName.get(tagName);
      if (!tag) continue;
      await request(baseUrl, `/api/tags/note/${note.id}/tag/${tag.id}`, {
        token,
        method: "POST",
      }).catch(() => {});
    }
    if (spec.pinned) {
      await request(baseUrl, `/api/notes/${note.id}`, {
        token,
        method: "PUT",
        body: { isPinned: 1 },
      }).catch(() => {});
    }
  }

  const tasks = await request(baseUrl, "/api/tasks", { token });
  if (!tasks.length) {    for (const spec of demoTasks) {
      const created = await request(baseUrl, "/api/tasks", {
        token,
        method: "POST",
        body: {
          title: spec.title,
          priority: spec.priority,
          dueDate: isoDate(spec.dueOffset),
          status: spec.status === "done" ? "todo" : spec.status,
        },
      });
      if (spec.status === "done") {
        await request(baseUrl, `/api/tasks/${created.id}/toggle`, { token, method: "PATCH" });
      }
    }
    log(`[data] 新建任务 ${demoTasks.length} 条`);
  }

  await arrangeDemoNotebooks({ baseUrl, token, log });
}

/**
 * 按展示顺序刷新演示笔记的更新时间。
 *
 * 笔记列表按「最近更新」排序，首次登录生成的官方指南会插在演示内容中间。
 * 这里按目标顺序倒序触发一次空更新（标题不变），让演示笔记排在列表前面，
 * 只影响排序，不改动正文内容。
 */
export async function touchDemoNotes({ baseUrl, token, log = console.log }) {
  const listed = await request(baseUrl, "/api/notes?limit=500", { token }).catch(() => null);
  const notes = Array.isArray(listed) ? listed : listed?.notes || [];
  const byTitle = new Map(notes.map((note) => [note.title, note]));
  const ordered = demoNotes.map((spec) => byTitle.get(spec.title)).filter(Boolean);

  for (const note of ordered.slice().reverse()) {
    await request(baseUrl, `/api/notes/${note.id}`, {
      token,
      method: "PUT",
      body: { title: note.title },
    }).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 280));
  }
  log(`[data] 已刷新 ${ordered.length} 篇演示笔记的排序时间`);
}
