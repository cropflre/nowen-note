# 富文本顶层标题拆分评估

## 结论

Tiptap 富文本笔记可以支持按顶层 H1/H2 拆分，并且应保持 `tiptap-json` 格式，不应先转成 Markdown。

实现复杂度中等，现有 Markdown 拆分的事务、标签、附件、版本历史和操作记录可以复用；标题规划、目录生成、撤销入口和块链接处理必须做格式感知实现。

当前阶段暂不直接开放富文本入口，原因不是解析困难，而是需要先收口下面的正确性边界。

## 可直接复用的能力

- `notes.version` 乐观锁与 SQLite 原子事务。
- `note_split_operations`、`note_split_items` 和即时撤销记录。
- 标签继承、目标笔记本权限和工作区隔离。
- 附件物理文件去重与拆分元数据跟踪。
- `extractSearchableText(..., "tiptap-json")` 全文索引派生。
- `syncNoteBlocks` 对 Tiptap 节点的块索引生成。
- `syncNoteLinks` 对文本中的 wiki 链接和 `link` mark 的双链提取。

## 富文本规划规则

只读取 Tiptap 文档根节点的 `doc.content`：

1. 仅将根节点中 `type === "heading"` 且 `attrs.level` 精确等于用户选择层级的节点视作边界。
2. 列表、引用、表格、折叠块等嵌套内容中的标题不作为拆分边界。
3. 标题文本递归收集其 text/hardBreak 子节点，去除运行时块 ID，仅作为章节笔记标题。
4. 章节正文为该标题节点之后、下一个同级边界之前的完整节点数组；节点、attrs、marks 和未知扩展字段原样保留。
5. 子笔记仍保存为：

```json
{
  "type": "doc",
  "content": []
}
```

标题节点本身不复制到章节正文，和 Markdown 拆分语义保持一致。

## 原笔记目录节点

目录不能写成普通的 `[[uuid|标题]]` 文本。Tiptap 中应生成标准 `link` mark：

```json
{
  "type": "text",
  "text": "章节标题",
  "marks": [
    {
      "type": "link",
      "attrs": {
        "href": "note:<uuid>",
        "rel": "noopener noreferrer nofollow nowen-title-alias"
      }
    }
  ]
}
```

建议的根节点顺序：

1. 用户选择保留的前言节点；
2. 拆分提示 blockquote；
3. 比拆分层级低一级的目录 heading；
4. orderedList / bulletList 目录；
5. 未选择的原始章节节点。

目录标题必须低于拆分层级，例如按 H2 拆分时生成 H3，避免下次扫描把“目录”误当成同级用户章节。

## 当前阻断项

### 1. 撤销入口仍是 Markdown 守卫

当前撤销路由调用的源笔记校验会拒绝 `contentFormat !== "markdown"`。富文本实现前应把权限、锁定、回收站校验与格式校验拆开：

- 拆分创建路由按格式选择 planner；
- 撤销路由只校验操作记录中的 `originalContentFormat` 与当前操作匹配，不应固定 Markdown。

### 2. 块链接迁移语义

拆分会把带 `blockId` 的节点从源笔记移动到章节笔记。已有指向 `note:源笔记#blk:<id>` 的外部块链接不会自动改成新章节 ID。

首版可选择：

- 拆分预览中统计被外部引用的块并提示；
- 或在事务内按 `blockId -> childNoteId` 映射更新 `note_links.targetNoteId`，同时重写来源笔记中的 href/wiki link。

在没有明确策略前，不应静默宣称“所有双链完整迁移”。

### 3. 富文本保存快照

Markdown 当前通过编辑器 flush 后重新 GET 最新服务端版本。富文本同样必须：

- 先强制提交编辑器 debounce；
- 再 GET 服务端权威正文与 version；
- 服务端基于该正文重新规划，不接受前端提交的节点内容。

### 4. 非法或历史 JSON

planner 必须拒绝：

- 无法 JSON.parse 的内容；
- 根节点不是 `type: "doc"`；
- `content` 不是数组；
- 少于两个可用同级顶层标题；
- 超过 200 个章节。

未知节点类型应原样保留，而不是因为当前 schema 不认识就删除。

## 推荐实施顺序

1. 新增纯函数 `planTiptapNoteSplit` 和节点级单元测试。
2. 抽取 Markdown/富文本共用的选择索引、事务、附件和操作记录服务。
3. 新增格式感知目录生成器，使用 `note:<uuid>` link mark。
4. 泛化撤销守卫并增加富文本事务测试。
5. 在 `EditorPaneRuntime` 中只对满足条件的 `tiptap-json` 笔记展示入口。
6. 最后处理或明确提示外部块链接迁移限制。

## 验收测试

至少覆盖：

- 仅顶层 H1/H2 生效，嵌套标题不切分；
- marks、表格、任务列表、图片、视频和未知节点完整保留；
- 选择部分章节时未选节点原样留在源笔记；
- 同一附件被已选和未选章节引用时不失效、不重复写磁盘；
- 目录 link mark 可点击并生成 `note_links`；
- 版本冲突整单回滚；
- 即时撤销恢复原始 JSON；
- 子笔记继续编辑或上传附件后拒绝自动撤销；
- 块链接迁移策略有明确测试与用户提示。
