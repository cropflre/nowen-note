# MD 文件规范 — Markdown-as-Source-of-Truth

> 本文档定义了 nowen-note 改造后"Markdown 文件夹为唯一真相源"的标准规范。
> 所有 Markdown 文件必须遵循此规范，扫描器才能正确解析并投影到 SQLite。

---

## 1. 目录结构规范

### 1.1 根目录

由环境变量 `NOWEN_MD_ROOT` 指定（默认 `~/notes/`），可挂载到 NAS / 云盘。

### 1.2 子目录命名

```
{{root}}/
├── 01-日记/              ← 命名空间: 序号-分类名
├── 02-知识库/
├── 03-待办/
├── 04-索引/              ← 自动生成
├── attachments/          ← 附件存储
├── templates/            ← 模板文件 (可选)
└── .nowen/               ← 元数据 (扫描状态/配置)
```

**规则**:
- 分类目录使用 `NN-名称` 前缀，`NN` 为 01-99 排序码
- 日记目录按 `YYYY/MM/YYYY-MM-DD.md` 组织
- 知识库目录可无限嵌套，目录名即为"笔记本名"
- 索引目录自动生成，不手动编辑

### 1.3 文件命名

```
# 知识库笔记
TypeScript类型系统.md          ← 笔记标题用作文件名
Rust所有权与生命周期.md

# 日记
2026-06-26.md                  ← 日记固定日期格式
2026-06-27.md

# 待办
购物清单.md                    ← 任务列表
项目A-后端开发.md
```

**规则**:
- 文件名即为笔记标题（无 frontmatter 时 fallback）
- 避免特殊字符: `\ / : * ? " < > |`
- 日记必须使用 `YYYY-MM-DD.md` 格式
- `.md` 是唯一允许的笔记文件扩展名

---

## 2. Frontmatter 规范

使用 YAML frontmatter（`---` 包裹），位于文件最开头。

### 2.1 字段定义

```yaml
---
# === 必选字段 ===
title: 笔记标题              # 字符串。无 frontmatter 时取文件名（不含 .md）

# === 建议字段 ===
created: 2026-06-26T10:00:00+08:00     # ISO 8601，带时区。不填取文件创建时间
updated: 2026-06-26T14:30:00+08:00     # ISO 8601，带时区。不填取文件修改时间
tags: [typescript, 编程笔记]           # 标签数组。也支持内联 #标签

# === 可选字段 ===
id: 550e8400-e29b-41d4-a716-446655440000  # UUID v4。用于双链稳定性
notebook: 编程/TypeScript                  # 覆盖目录映射。格式: 分类/子目录/...
pinned: false                              # 是否置顶
archived: false                            # 是否归档
aliases: [旧标题A, 旧标题B]                # 别名，双链 redirect
source: https://example.com/article.html   # 来源链接（AI 摘要入库时填入）
summary: 这篇文章介绍了Rust的所有权系统...  # AI 自动摘要
---
```

### 2.2 类型约束

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `title` | string | 文件名 | 笔记标题 |
| `created` | ISO 8601 | 文件 ctime | 创建时间 |
| `updated` | ISO 8601 | 文件 mtime | 修改时间 |
| `tags` | string[] | `[]` | 标签列表 |
| `id` | string (uuid) | 自动生成 | 稳定标识符 |
| `notebook` | string | 目录路径 | 笔记本路径 |
| `pinned` | boolean | false | 置顶 |
| `archived` | boolean | false | 归档 |
| `aliases` | string[] | `[]` | 别名列表 |
| `source` | string | `""` | 来源 URL |
| `summary` | string | `""` | AI 摘要 |

### 2.3 示例

```markdown
---
title: Rust 所有权系统详解
created: 2026-06-25T14:00:00+08:00
updated: 2026-06-26T09:30:00+08:00
tags: [rust, 编程语言, 内存管理]
aliases: [rust所有权, ownership]
summary: Rust 的所有权机制通过编译时检查保证内存安全，无需垃圾回收。
---

# Rust 所有权系统

Rust 的所有权（Ownership）是一套内存管理规则……

## 所有权规则

1. 每个值都有一个变量作为它的**所有者**
2. 同一时间只有一个所有者
3. 当所有者离开作用域，值被丢弃

## 引用与借用

```rust
fn main() {
    let s = String::from("hello");
    let len = calculate_length(&s);
}
```
```

---

## 3. 内容语法规范

### 3.1 双链 `[[Title]]`

```
语法: [[笔记标题]]          ← 链接到同 notebook 的笔记
      [[笔记标题|别名]]     ← 链接并指定显示文本
      [[notebook/笔记标题]] ← 链接到指定 notebook 的笔记
```

**规则**:
- 双链标题区分大小写
- 匹配规则: 精确匹配 `title` → fallback 文件名匹配
- 未匹配的链接标记为"断裂链接"，记录到索引文件
- 别名（aliases）参与匹配

### 3.2 标签

```
内联语法: #标签名              ← 正文内标签
          #标签名/子标签       ← 层级标签

Frontmatter: tags: [标签名, 标签名]
```

**规则**:
- 中文标签也支持: `#编程/TypeScript`
- frontmatter `tags:` 和内联 `#标签` 都会解析
- 内联标签不会出现在标题行或代码块内
- 标签自动去重

### 3.3 任务列表

```markdown
- [ ] 未完成的任务
- [x] 已完成的任务
- [ ] 高优先级任务 @high
- [ ] 截止日期 @2026-07-01
```

**规则**:
- `- [ ]` 和 `- [x]` 是唯一可识别的任务格式
- `@high` `@medium` 标记优先级
- `@2026-07-01` 标记截止日期
- 子任务缩进 2 空格

### 3.4 附件引用

```markdown
![图片描述](attachments/2026/06/abc123.png)     ← 图片
[文件下载](attachments/2026/06/report.pdf)       ← 附件
```

**规则**:
- 附件路径相对 `{{root}}/attachments/`
- 图片自动生成缩略图
- PDF/DOCX 等二进制文件提取文本到 contentText

---

## 4. 扫描器行为约定

### 4.1 文件过滤

**排除**（不扫描）:
- `.git/`, `node_modules/`, `.nowen/` 目录
- 隐藏文件（`.` 开头）
- 临时文件（`~` 结尾, `*.swp`, `*.tmp`）
- 非 `.md` 扩展名
- 大于 10MB 的文件

**包含**（扫描）:
- `*.md` 文件（UTF-8 编码）
- 无 frontmatter 的纯 Markdown 文件（自动补全元数据）

### 4.2 变更检测

扫描器通过 `SHA256` 判断文件是否变化:
1. 首次扫描: 计算所有文件的 SHA256 → 存入 `.nowen/scan-state.json`
2. 增量扫描: 对比 SHA256，只处理变化的文件
3. 文件删除: 检测到文件不在目录中 → 标记笔记为"孤立"（不自动删除）

### 4.3 优先级规则

```
文件系统变更 > 扫描器变更 > DB 更新
```

- 文件系统是唯一信任源
- 扫描器写入 DB 时不做冲突检测（DB 本来就可丢弃）
- 扫描器不修改文件内容（例外: AI 摘要/标签写入 frontmatter）

---

## 5. 与 nowen-note 原生格式的关系

| 场景 | 行为 |
|---|---|
| 新建笔记（Web UI） | 可选保存为 MD 格式 → 写入文件系统 + DB |
| 新建笔记（扫描器） | 写入 DB + 提取元数据到 SQLite 表 |
| 编辑笔记（Web UI） | 更新 DB → 可选同步回文件 |
| 编辑笔记（编辑器外） | 文件变化 → watcher 触发 → DB 更新 |
| 删除文件 | 笔记标记为"孤立"，保留在 DB 中 |
| 移动文件 | 重新扫描后更新 notebook 映射 |
| 重命名文件 | 更新标题 |
