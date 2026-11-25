# Offline Source → NMF example / 离线来源适配示例

`input.json` is synthetic. `custom-json-to-nmf.ts` converts this explicit example
format into NMF v1, using the same frozen schemas as the migration service. It
does not connect to an account, read a default notes directory, upload, or write
business data. It supports text, folders and tags only; attachments, rich text,
original dates and links require an explicit source-specific extension.

`input.json` 是合成资料；脚本只转换明确选择的示例 JSON，支持正文、目录、标签，
不访问平台账号、不扫描默认私人目录、不上传、不写业务数据库。附件、富文本、
原时间和引用需要另行实现和验证，不能凭空补全。

From the repository root / 仓库根目录：

```sh
cd backend
node --import tsx ../docs/examples/migration-adapter/custom-json-to-nmf.ts ../docs/examples/migration-adapter/input.json /tmp/nowen-custom-nmf-example
```

The destination must not exist. Input is a regular UTF-8 file, at most 2MiB;
unknown fields and duplicate source IDs are refused. Source IDs remain external
identities and do not become Nowen primary keys. The script does not overwrite
existing directories or modify the source file. Only use output after exit 0.

目标目录必须不存在；输入是最多 2MiB 的 UTF-8 普通文件。未知字段与重复来源 ID
会被拒绝；来源 ID 不作为 Nowen 内部主键。只使用退出码为 0 的输出。

ZIP the **contents** of the output directory so `manifest.json` and `notes/`
are at the archive root. Upload through the migration hub, inspect the preview,
and confirm in Nowen Note. For AI staging, consume the normalized notes through
the existing Migration API/MCP instead; do not build another writing engine.

把输出目录的**内容**打包，使 `manifest.json` 和 `notes/` 位于 ZIP 根目录，再到
迁移中心上传、预览并确认。AI 也可将规范化内容通过已有 Migration API/MCP 分批
暂存，不应另建笔记写入引擎。

Contract: [中文](../../architecture/migration-source-adapters.md),
[English](../../architecture/migration-source-adapters.en.md).
