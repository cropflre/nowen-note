# M6～M7 Block 权威存储与 Subdocument 窗口化设计

## 目标

在不破坏旧客户端整篇保存能力的前提下，为 Block 权威读取提供可灰度开关，并把超大 Tiptap 文档的章节 Subdocument 从静态实验推进到具备结构代际、离线恢复和安全回退的窗口化编辑路径。

## 范围

- M6：Block 权威模式、统一正文写入边界、Block/结构版本、操作历史、附件引用、兼容快照、SQLite/PostgreSQL Repository 和恢复健康检查。
- M7：章节清单代际、结构版本、受控重分段、章节增量同步、离线恢复、跨章节安全回退、搜索定位、IME 生命周期和 A/B 性能标签。
- 不在本阶段默认开启 Block 主读或窗口化；两者必须显式灰度。
- 不在多个 ProseMirror 实例之间伪造跨编辑器事务。无法无损证明的跨章节操作切换到单体编辑器。

## M6 架构

### 运行模式

服务端读取 `NOWEN_BLOCK_AUTHORITY_MODE`：

- `shadow`：默认值。`notes.content` 是读取来源，Block 存储作为双写校验、历史和冲突来源。
- `primary`：健康 Block 文档是读取来源；缺失或 mismatch 时退回 `notes.content`。旧客户端整篇写入仍然接受，并同步重建 Block。

未知值按 `shadow` 处理，避免配置拼写导致意外切换。

### 写入边界

新增正文持久化协调器，所有整篇正文写入以同一事务维护：

1. 更新 `notes.content/contentText/version`。
2. 同步 Block 索引、双链和附件引用。
3. 重建 Block 权威记录，维护 Block/结构版本。
4. 写入操作历史。
5. 在启用 Subdocument 时重建或校验章节状态。

Block Patch 和 Y.js 章节更新可以继续使用其专用规划器，但最终必须调用相同的权威重建与健康判定逻辑。任何步骤失败都回滚整个事务。

### 读取与回退

- `shadow` 始终返回 `notes.content`，同时返回 Block 健康状态。
- `primary` 仅在记录图、payload hash、物化 hash、兼容快照 hash 全部一致时返回 Block 物化内容。
- 不一致时标记 mismatch 并返回 `notes.content`，不自动覆盖任一侧。
- 读取修复只允许在 Block 缺失时从兼容快照重建；已有 mismatch 不静默修正。

### 跨库 Repository

Repository 通过 `DatabaseAdapter` 提供文档、记录、操作历史的读取和原子替换写入。SQL 使用 SQLite/PostgreSQL 共同支持的 `?` 占位符和 `ON CONFLICT` 语义；时间值由调用方传入，避免 `datetime('now')` 与 `NOW()` 分叉。PostgreSQL 原始 JSON 载荷继续存为 TEXT，保证 Markdown 和 Tiptap 序列化行为一致。

### 兼容与恢复

- 旧客户端整篇保存：更新兼容快照并重建 Block。
- 版本恢复、导入和用户迁移：写入后运行 Block 健康同步；失败保留 `notes.content` 并记录 mismatch。
- SQLite 完整备份自然包含新表；旧备份恢复后由迁移建表，再按需回填。
- 删除笔记依赖外键级联清理 Block、历史、附件引用和 Subdocument。

## M7 架构

### 清单协议

章节清单增加：

- `generation`：每次章节边界或顺序变化递增。
- `structureVersion`：与 Block 权威结构版本对齐。
- 每个章节包含稳定 `id/guid/startBlock/endBlock/payloadHash`。

章节 GET/POST 必须携带客户端 generation。过期 generation 返回 409 和最新清单，不应用更新。

### 章节更新与重分段

- 普通章节正文更新只修改该章节 Y.Doc，随后物化兼容快照和 Block 权威状态。
- 若更新改变顶层 Block 数量、一级/二级标题边界或 Block 顺序，则在同一事务中重新切分全部章节并递增 generation。
- 未改变边界的章节保留 GUID；新增或合并章节获得确定性 GUID。
- 重分段完成后清理旧章节 update 日志，避免旧 generation 增量再次应用。

### 前端窗口化

- 只为进入视口缓冲区的章节创建 Y.Doc 和编辑器实例；首章常驻。
- 未加载章节只保留清单和估算高度。
- 远端章节更新：已加载章节立即应用；未加载章节合并到待应用队列，首次加载时先应用队列。
- 离线 pending 按 noteId、generation、sectionId 持久化。代际不匹配时停止发送并进入安全回退，不丢弃原始更新。

### 跨章节行为

- 检测到选择锚点和焦点位于不同章节、跨章节拖拽、结构 Undo 或章节边界变化时，先抓取所有已挂载快照并等待 pending 落盘，再切换单体编辑器。
- 切换载荷必须包含最新物化正文；单体编辑器不得回退到旧的 `props.note.content`。
- IME composition 期间禁止卸载当前章节。
- 搜索先从当前章节值和清单摘要定位目标章节，加载后定位精确结果。
- 远端光标仅渲染已加载章节；其他章节保留参与者摘要。

### A/B 验收

性能报告增加 `editorMode: monolithic|subdocument`、章节数和峰值挂载章节数。相同样本分别运行两种模式，记录输入 p50/p95、最长任务、首次可输入、内存和关闭后残留。窗口化不会因代码存在而默认启用。

## 错误处理

- Block mismatch：读取回退兼容快照，写入保留 mismatch，等待显式修复。
- generation 冲突：409 返回最新清单，客户端停止当前章节发送并安全回退。
- 离线/网络不确定：合并并持久化 update，不执行整篇盲写。
- Subdocument 内容无法解析或需要规范化：事务回滚，返回明确错误码。
- 跨章节状态无法无损合并：保存当前窗口快照后切换单体编辑器。

## 测试与验收

- 模式解析、shadow/primary 读取、mismatch 回退。
- 统一写入事务成功和任一步失败回滚。
- SQLite/PostgreSQL Repository SQL 与原始字符串类型。
- 整篇旧客户端保存、版本恢复、导入后的 Block 健康状态。
- generation 冲突、普通章节更新、结构变化重分段、旧 update 拒绝。
- 离线重启恢复、未加载远端更新、跨章节选择/拖拽安全回退、IME 不卸载、搜索定位。
- M4 性能协议输出单体/窗口化 A/B 标签。

## 上线策略

1. 发布时保持 `shadow` 和窗口化关闭。
2. 完成回填并观察 mismatch 指标。
3. 小范围启用 `primary`，旧客户端仍可整篇保存。
4. 独立灰度窗口化；generation 冲突率和安全回退率进入验收报告。
5. 只有真实设备 A/B 数据满足预算后，才讨论扩大默认范围。
