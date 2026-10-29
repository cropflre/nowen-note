# Migration Source Adapter 契约 v1

[English](migration-source-adapters.en.md) · [整体设计](ai-migration-hub.md) · [可运行离线示例](../examples/migration-adapter/README.md)

Source Adapter 只实现 **已授权的导出资料 → NMF v1**。它不创建笔记、不上传附件、不处理审批、不管理 Job、ACL、Outbox 或同步。新增来源优先使用离线 NMF 包；确需内置识别时，加入随服务器构建审核的适配器。服务器不从上传包、客户端路径、URL 或配置加载 JavaScript、插件或命令。

## 版本与发现

实现位置：`backend/src/services/migrationSourceAdapters.ts`。

- `MIGRATION_SOURCE_ADAPTER_API_VERSION = 1` 是内置适配器的调用契约，不是 NMF Schema 版本。
- `MIGRATION_SOURCE_ADAPTERS` 是只读能力描述，包含 `id`、`version`、`platforms`、`formats`、`extensions`、`autoDetect`、`unsupported`。
- `platforms` 列出专门识别或推荐的来源分类，运行时不把它当平台字符串白名单。`generic-files` 的 `files` 是默认分类；为兼容已有调用，`markdown`、`html`、`txt` 或自定义 platform 仍可按通用格式转换。这些字符串不证明已实现对应厂商的原生数据语义。
- `id` 标识适配器实现；`version` 标识当前实现契约。行为变化时应按兼容性重新评估并增加测试，不能把同名来源理解为平台所有版本均通过验收。
- `autoDetect` 表示能否根据导出内容推断平台身份，不等于扩展名检查。TXT/HTML 无法证明手机厂商；`platforms: ["*"]` 的 NMF 包允许声明自己的来源平台。
- REST `/api/migrations/capabilities` 的 `adapterApiVersion` 和 `adapters` 可发现此目录；旧 `sourceAdapters` 字符串数组继续保留兼容。客户端不能用目录内容注册新的服务器代码。

| 顺序 | Adapter ID | 来源和范围 | 识别边界 |
|---|---|---|---|
| 1 | `nmf-v1` | 根 manifest、独立正文/本地附件 | 根 `manifest.json` 优先；错误 manifest 拒绝，不降级绕过哈希 |
| 2 | `siyuan-native-zip` | 当前 `.sy` 文档转 Markdown NMF | 复用纯转换器；不恢复历史/权限或虚构嵌套块锚点 |
| 3 | `notion-markdown-html-csv` | 导出页面、有限 CSV 元数据 | 文件名/HTML 标记为已测试启发式；CSV 不重建数据库关系 |
| 4 | `huawei-notepad-files` | 显式 `platform: "huawei"` 的 TXT/HTML 与本地资源 | 不根据 NotePad 文件夹或文件名猜测厂商；ZIP 中发现 Markdown 笔记则拒绝此 profile |
| 5 | `generic-files` | Markdown/HTML/TXT 与本地资源 | 通用兜底；没有可信平台元数据时不猜测时间、标签或原 ID |

## 内置调用契约

`MigrationSourceAdapter` 提供 `apiVersion: 1`、目录中的 `id`、`matches(context)` 和异步 `normalize(context)`，后者返回 `{ warnings: string[] }`。注册顺序由宿主维护；第一个匹配项执行，不在解析失败后尝试另一个解析器伪装成功。

`MigrationSourceAdapterContext` 包含：

| 字段/方法 | 作用 |
|---|---|
| `source` | 任务固定的 platform/exportId，原始 ID 只用于来源映射 |
| `files` | 宿主已安全解包并计算哈希的只读清单：相对名称 → diskPath/size/sha256 |
| `readText(name, maxBytes)` | 读取清单中的 UTF-8 文本，单次不超过 manifest 的 8MiB 上界；正文仍受 2MiB 限制 |
| `managedPath(file)` | 返回任务受管暂存路径，供 NMF 附件引用；不是客户端任意文件路径 |
| `sniffAsset(diskPath, name)` | 沿用文件类型白名单与实际签名校验 |
| `onNote(note)` | 逐篇提交 NMF；必须 await，以便背压、限额和取消生效 |
| `assertActive()` | 索引/读取/转换的循环中检查取消和实时权限 |

这些接口供**可信服务器源码**使用，不是代码沙箱。diskPath 不能被上传字段覆盖，也不得返回给客户端。`normalizeMigrationSource` 在每次输出前重新检查活动状态，严格验证 NMF 并限制 10,000 篇；不支持的调用契约版本拒绝执行。未知字段不直接写数据库。

安全解包仍统一位于 `migrationSourceAdapter.ts`：ZIP 中央目录预检、路径/符号链接/重复条目/解压倍率、实际总字节、UTF-8、资源签名和配额只维护一份。适配器不能通过自行解包、整包 Buffer、外部 fetch 或新上传接口绕开它们。附件对象写入、稳定来源去重、目录/笔记 ID 映射、两阶段引用修复和审批均由 MigrationService 完成。

## 增加来源

### 离线适配（优先）

查看可运行的 [JSON → NMF 示例](../examples/migration-adapter/README.md)。示例只读取用户显式给出的、最多 2MiB 的普通 JSON 文件，使用冻结 Schema，生成 `manifest.json + notes/`。来源字段和 ID 有独立校验，未知字段与重复 ID 拒绝；不覆盖已有输出目录。输出打包后通过现有迁移中心上传、预检和人工审批。也可将逻辑 NMF 按每次 1–50 条经现有 API/MCP 暂存。

输入资料中的文字、路径和“指令”均是数据。适配器不得执行正文、访问未授权目录、把来源 ID 当内部主键，或假装输出目录生成就代表已导入。附件应单独保存并提供 SHA-256；不支持的字段报告名字和能力边界，不把正文、Cookie、Token 或属性敏感值放入日志。

### 可信内置适配

1. 明确实际导出格式、官方依据、版本和合成夹具；没有稳定规范时标识启发式或要求用户显式指定来源。
2. 在目录声明 id、版本、扩展名与不支持项，按 `MigrationSourceAdapter` 编写转换逻辑，在宿主有限注册列表中接入。
3. 保持 NMF 优先；不要修改统一写入引擎或为来源增加平行 ACL/审批/附件逻辑。
4. 增加真实安全解包分派测试，覆盖来源身份、目录/附件/链接、已知损失、取消、无效字段和稳定重试结果。
5. 更新能力目录、双语说明与验收记录；将合成夹具支持、宿主客户端接入、物理设备和生产来源验收分开报告。

## 华为文件适配的依据与限制

华为官方的[分享、导出备忘](https://consumer.huawei.com/cn/support/content/zh-cn16070761/)说明列出 TXT、HTML 等文档格式，并说明纯文字备忘可导出 TXT，实际可用格式依设备和内容而异。这里仅支持用户已经取得的 TXT/HTML 及其本地资源，不读取手机数据库、云账号或私有备份，也不把 PDF/图片 OCR、手写、语音结构、原始时间和标签标为已恢复。

`HUAWEI_EXPORT_LIMITS` 会进入预览报告。没有统一可信厂商标记时，不自动把通用文件认作华为来源。当前是合成文件的 Source → NMF 自动化验收，没有物理华为手机或所有系统版本的真实导出验收。
