import type Database from "better-sqlite3";
import type { Migration } from "./migrations.impl.js";

const ONBOARDING_VERSION = 1;
const ID_PREFIX = `onboarding-v${ONBOARDING_VERSION}-`;

interface GuideNote {
  key: string;
  language: "zh" | "en";
  title: string;
  content: string;
  contentText: string;
}

const GUIDE_NOTES: GuideNote[] = [
  {
    key: "welcome",
    language: "zh",
    title: "欢迎使用 Nowen Note",
    content: `# 欢迎使用 Nowen Note

Nowen Note 是一个**开源、自托管、数据由你掌控**的知识库、协作笔记与任务工作台。

## 从这里开始

1. 在左侧知识树中新建笔记本、文件夹或笔记。
2. 根据内容选择富文本编辑器或 Markdown 编辑器。
3. 使用标签、双链、附件、任务和 AI，把零散信息整理成自己的知识库。

## 推荐阅读

- [[5 分钟快速上手]]
- [[富文本与 Markdown]]
- [[知识树、双链与标签]]
- [[图片、附件与文件管理]]
- [[AI 知识问答]]
- [[任务、协作与多端访问]]
- [[数据安全、备份与自托管]]

> 这些教程都是普通笔记，可以自由编辑、移动或删除。删除后系统不会重新创建。
`,
    contentText: "欢迎使用 Nowen Note。Nowen Note 是一个开源、自托管、数据由你掌控的知识库、协作笔记与任务工作台。",
  },
  {
    key: "quick-start",
    language: "zh",
    title: "5 分钟快速上手",
    content: `# 5 分钟快速上手

## 1. 建立自己的目录

在左侧知识树点击 **+**，创建笔记本、文件夹、富文本笔记或 Markdown 文档。目录支持拖拽排序和多层级整理。

## 2. 写下第一篇笔记

- 富文本适合会议纪要、清单、表格和日常记录。
- Markdown 适合技术文档、代码和跨平台迁移。

## 3. 让内容彼此关联

输入双链引用其他笔记，添加标签，并通过知识树快速定位内容。

## 4. 保存图片和附件

粘贴、拖入或上传图片与文件，它们会统一进入文件管理。

## 5. 继续探索

打开任务中心、AI 知识问答、说说、思维导图和协作功能，按自己的工作方式组合使用。
`,
    contentText: "5 分钟快速上手：建立目录、创建富文本或 Markdown 笔记、添加双链和标签、上传图片附件并探索任务与 AI。",
  },
  {
    key: "editors",
    language: "zh",
    title: "富文本与 Markdown",
    content: `# 富文本与 Markdown

Nowen Note 同时提供两种编辑体验。

## 富文本编辑器

适合直接排版，支持标题、列表、任务清单、表格、引用、代码块、图片和附件。

## Markdown 编辑器

适合技术写作和可迁移文档，支持源码、预览与分屏模式。

\`\`\`ts
const note = "Your data, your knowledge";
\`\`\`

## 怎么选择

- 追求所见即所得：选择富文本。
- 需要源码可控、Git 友好：选择 Markdown。
- 两种格式可以共存于同一个知识树中。
`,
    contentText: "富文本适合所见即所得排版，Markdown 适合技术写作、源码控制和跨平台迁移，两种格式可以共存。",
  },
  {
    key: "knowledge-tree",
    language: "zh",
    title: "知识树、双链与标签",
    content: `# 知识树、双链与标签

## 知识树

使用笔记本和文件夹建立层级结构。目录支持展开、折叠、拖拽移动和排序。

## 双链

在正文中引用另一篇笔记，让知识形成网络。被引用笔记可以查看反向链接，快速找到相关上下文。

## 标签

标签适合跨目录归类，例如「项目」「待整理」「灵感」。目录负责位置，标签负责主题，双链负责关系。

建议从简单结构开始，等内容增长后再逐步细分。
`,
    contentText: "知识树负责层级位置，标签负责跨目录主题，双链负责笔记之间的关系与反向链接。",
  },
  {
    key: "files",
    language: "zh",
    title: "图片、附件与文件管理",
    content: `# 图片、附件与文件管理

你可以在编辑器中粘贴、拖拽或上传图片和文件。

- 图片会在正文中显示，并支持预览。
- 文件统一进入文件管理，可按类型、大小和时间查找。
- 导入 Markdown 或第三方笔记时，受支持的图片会尽量本地化保存。
- 删除笔记前，请确认其中的附件是否仍被其他内容引用。

自托管部署时，附件保存在你自己的服务器或 NAS 中。
`,
    contentText: "图片和附件可以粘贴、拖拽或上传，并统一进入文件管理；自托管时文件保存在自己的服务器或 NAS。",
  },
  {
    key: "ai",
    language: "zh",
    title: "AI 知识问答",
    content: `# AI 知识问答

配置 AI 服务后，可以基于自己的笔记进行提问、总结和写作辅助。

## 常见用法

- 总结当前笔记或一组资料。
- 从知识库中查找答案并查看引用来源。
- 改写、翻译、扩写或整理选中文本。
- 将零散记录转换为结构化文档。

AI 生成内容可能存在错误。重要结论请结合引用来源和原始资料核对。
`,
    contentText: "AI 知识问答支持基于笔记提问、总结、改写、翻译和整理，并展示引用来源；重要结论需要核对。",
  },
  {
    key: "tasks-collaboration",
    language: "zh",
    title: "任务、协作与多端访问",
    content: `# 任务、协作与多端访问

## 任务

把笔记中的行动项整理到任务中心，设置优先级、截止日期和完成状态。

## 协作

通过共享笔记本或工作区邀请成员，根据需要分配查看或编辑权限。

## 多端访问

可以通过 Web、桌面端和移动端访问同一套数据。客户端还可以配置离线同步，在网络不稳定时继续阅读和编辑。
`,
    contentText: "任务中心用于管理行动项；共享笔记本和工作区支持成员协作；Web、桌面和移动端可访问并支持离线同步。",
  },
  {
    key: "security",
    language: "zh",
    title: "数据安全、备份与自托管",
    content: `# 数据安全、备份与自托管

Nowen Note 支持自托管，数据可以保存在自己的电脑、服务器或 NAS 中。

## 建议

- 定期使用数据管理中的备份与导出功能。
- 对数据库和附件目录同时做备份。
- 为远程访问配置 HTTPS、强密码和必要的访问控制。
- 升级前先创建可恢复的备份。
- 不要把唯一副本只保存在单块硬盘中。

掌控数据也意味着需要认真对待备份和恢复。
`,
    contentText: "Nowen Note 支持自托管。请同时备份数据库和附件目录，远程访问使用 HTTPS 和强密码，升级前先创建可恢复备份。",
  },
  {
    key: "welcome",
    language: "en",
    title: "Welcome to Nowen Note",
    content: `# Welcome to Nowen Note

Nowen Note is an **open-source, self-hosted knowledge base, collaborative notebook, and task workspace** that keeps your data under your control.

## Start here

1. Create a notebook, folder, or note from the knowledge tree.
2. Choose the rich-text editor or Markdown for each document.
3. Connect your knowledge with tags, backlinks, attachments, tasks, and AI.

## Recommended guides

- [[5-Minute Quick Start]]
- [[Rich Text and Markdown]]
- [[Knowledge Tree, Backlinks, and Tags]]
- [[Images, Attachments, and File Manager]]
- [[AI Knowledge Q&A]]
- [[Tasks, Collaboration, and Multi-Device Access]]
- [[Data Safety, Backups, and Self-Hosting]]

> These guides are normal notes. You can edit, move, or delete them, and they will not be recreated after deletion.
`,
    contentText: "Welcome to Nowen Note, an open-source, self-hosted knowledge base, collaborative notebook, and task workspace that keeps your data under your control.",
  },
  {
    key: "quick-start",
    language: "en",
    title: "5-Minute Quick Start",
    content: `# 5-Minute Quick Start

## 1. Build your structure

Use the **+** button in the knowledge tree to create notebooks, folders, rich-text notes, or Markdown documents. Drag items to organize them into multiple levels.

## 2. Write your first note

- Rich text works well for meeting notes, checklists, tables, and daily writing.
- Markdown works well for technical documentation, code, and portable files.

## 3. Connect related ideas

Link to other notes, add tags, and use the knowledge tree to navigate your workspace.

## 4. Add images and files

Paste, drag, or upload files. They are managed together in File Manager.

## 5. Explore more

Try Tasks, AI Knowledge Q&A, Moments, Mind Maps, and collaboration when you need them.
`,
    contentText: "Build a directory, create rich-text or Markdown notes, add links and tags, upload files, and explore Tasks and AI Knowledge Q&A.",
  },
  {
    key: "editors",
    language: "en",
    title: "Rich Text and Markdown",
    content: `# Rich Text and Markdown

Nowen Note supports two editing experiences.

## Rich-text editor

Use it for visual formatting with headings, lists, task items, tables, quotes, code blocks, images, and attachments.

## Markdown editor

Use it for technical writing, portable documents, and source control. Source, preview, and split views are available.

\`\`\`ts
const note = "Your data, your knowledge";
\`\`\`

## Which one should you choose?

- Choose rich text for a direct, visual editing experience.
- Choose Markdown for source-level control and Git-friendly files.
- Both formats can live together in the same knowledge tree.
`,
    contentText: "Rich text provides visual editing, while Markdown provides source-level control and portable, Git-friendly documents. Both formats can coexist.",
  },
  {
    key: "knowledge-tree",
    language: "en",
    title: "Knowledge Tree, Backlinks, and Tags",
    content: `# Knowledge Tree, Backlinks, and Tags

## Knowledge tree

Use notebooks and folders to create a hierarchy. You can expand, collapse, move, and reorder items.

## Backlinks

Link one note to another to build a connected knowledge network. Referenced notes can show backlinks to their original context.

## Tags

Tags organize ideas across folders, such as “project,” “inbox,” or “idea.” Folders describe location, tags describe topics, and links describe relationships.

Start simple and add structure as your knowledge base grows.
`,
    contentText: "Folders describe location, tags describe topics across folders, and backlinks describe relationships between notes. Start simple and expand gradually.",
  },
  {
    key: "files",
    language: "en",
    title: "Images, Attachments, and File Manager",
    content: `# Images, Attachments, and File Manager

Paste, drag, or upload images and files directly in the editor.

- Images appear in the document and support preview.
- Files are collected in File Manager and can be filtered by type, size, or date.
- When importing Markdown or third-party notes, supported images can be localized into your storage.
- Before deleting a note, check whether its files are still referenced elsewhere.

With self-hosting, attachments remain on your own server or NAS.
`,
    contentText: "Paste, drag, or upload images and files. File Manager keeps them organized, and self-hosted attachments remain on your own server or NAS.",
  },
  {
    key: "ai",
    language: "en",
    title: "AI Knowledge Q&A",
    content: `# AI Knowledge Q&A

After configuring an AI provider, you can ask questions, summarize notes, and improve your writing using your own knowledge base.

## Common uses

- Summarize the current note or a collection of sources.
- Find answers in your knowledge base and inspect cited sources.
- Rewrite, translate, expand, or organize selected text.
- Turn quick captures into structured documents.

AI output can be inaccurate. Verify important conclusions against the cited and original sources.
`,
    contentText: "AI Knowledge Q&A can answer questions from your notes, summarize, rewrite, translate, and organize text with source citations that should be verified.",
  },
  {
    key: "tasks-collaboration",
    language: "en",
    title: "Tasks, Collaboration, and Multi-Device Access",
    content: `# Tasks, Collaboration, and Multi-Device Access

## Tasks

Turn action items into tasks, then manage priority, due dates, and completion status in Task Center.

## Collaboration

Share a notebook or invite members to a workspace with viewer or editor permissions.

## Multi-device access

Use the same data from the web, desktop, and mobile clients. Offline synchronization can keep notes available when the network is unreliable.
`,
    contentText: "Task Center manages action items, shared notebooks and workspaces support collaboration, and web, desktop, and mobile clients provide multi-device access and offline sync.",
  },
  {
    key: "security",
    language: "en",
    title: "Data Safety, Backups, and Self-Hosting",
    content: `# Data Safety, Backups, and Self-Hosting

Nowen Note can be self-hosted on your computer, server, or NAS.

## Recommendations

- Create regular backups and exports from Data Management.
- Back up both the database and attachment directory.
- Use HTTPS, strong passwords, and appropriate access controls for remote access.
- Create a recoverable backup before upgrading.
- Never keep the only copy of important data on a single drive.

Owning your data also means taking backups and recovery seriously.
`,
    contentText: "Self-host Nowen Note on your own computer, server, or NAS. Back up the database and attachments, use HTTPS and strong passwords, and create backups before upgrades.",
  },
];

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function expressionId(suffix: string): string {
  return `(${sqlString(ID_PREFIX)} || NEW.id || ${sqlString(`-${suffix}`)})`;
}

function notebookInsert(params: {
  suffix: string;
  parentSuffix?: string;
  name: string;
  icon: string;
  sortOrder: number;
}): string {
  const parent = params.parentSuffix ? expressionId(params.parentSuffix) : "NULL";
  return `
    INSERT INTO notebooks (
      id, userId, parentId, name, description, icon, sortOrder, isExpanded
    ) VALUES (
      ${expressionId(params.suffix)},
      NEW.id,
      ${parent},
      ${sqlString(params.name)},
      ${sqlString("Nowen Note onboarding guide / 新用户使用指南")},
      ${sqlString(params.icon)},
      ${params.sortOrder},
      1
    );`;
}

function noteInsert(note: GuideNote, sortOrder: number): string {
  const notebookSuffix = note.language;
  const noteSuffix = `${note.language}-${note.key}`;
  return `
    INSERT INTO notes (
      id, userId, notebookId, title, content, contentText,
      contentFormat, isPinned, sortOrder
    ) VALUES (
      ${expressionId(noteSuffix)},
      NEW.id,
      ${expressionId(notebookSuffix)},
      ${sqlString(note.title)},
      ${sqlString(note.content)},
      ${sqlString(note.contentText)},
      'markdown',
      ${note.key === "welcome" ? 1 : 0},
      ${sortOrder}
    );`;
}

/**
 * v61 installs an INSERT-only seed trigger for future accounts.
 *
 * Existing users are intentionally not backfilled. Because the trigger only runs
 * when the user row is first created, deleting the guide never recreates it on
 * login, update, restart, migration, or ordinary synchronization.
 */
export const newUserOnboardingMigration: Migration = {
  version: 61,
  name: "new-user-bilingual-onboarding",
  up: (db: Database.Database) => {
    const noteStatements = GUIDE_NOTES.map((note, index) => (
      noteInsert(note, index % (GUIDE_NOTES.length / 2))
    )).join("\n");

    db.exec(`
      DROP TRIGGER IF EXISTS users_seed_onboarding_after_insert;
      CREATE TRIGGER users_seed_onboarding_after_insert
      AFTER INSERT ON users
      BEGIN
        ${notebookInsert({
          suffix: "root",
          name: "Nowen Note 使用指南 / Guide",
          icon: "📘",
          sortOrder: -1000,
        })}
        ${notebookInsert({
          suffix: "zh",
          parentSuffix: "root",
          name: "中文指南",
          icon: "🇨🇳",
          sortOrder: 0,
        })}
        ${notebookInsert({
          suffix: "en",
          parentSuffix: "root",
          name: "English Guide",
          icon: "🇬🇧",
          sortOrder: 1,
        })}
        ${noteStatements}
      END;
    `);
  },
};

export function onboardingWelcomeNoteId(userId: string): string {
  return `${ID_PREFIX}${userId}-zh-welcome`;
}
