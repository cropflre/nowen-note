# Migration Source Adapter contract v1

[中文](migration-source-adapters.md) · [Architecture](ai-migration-hub.md) · [Runnable offline example](../examples/migration-adapter/README.md)

An adapter converts **authorized export data into NMF v1**. It does not create notes, upload assets, approve jobs, or own ACL, Outbox or sync behavior. Prefer an offline NMF package for a new source. Built-ins are reviewed source code shipped with the server; uploads, client paths, URLs and settings never load JavaScript, commands or plugins.

## Versions and discovery

`backend/src/services/migrationSourceAdapters.ts` exports `MIGRATION_SOURCE_ADAPTER_API_VERSION = 1` and the read-only `MIGRATION_SOURCE_ADAPTERS` catalog. Catalog entries contain `id`, `version`, `platforms`, `formats`, `extensions`, `autoDetect` and `unsupported`. The adapter API version is separate from the NMF schema version. An implementation version does not promise compatibility with every platform export or release.

`autoDetect` describes platform identification, not extension validation. A TXT file or a `NotePad` directory cannot establish its vendor. NMF uses `platforms: ["*"]` because a validated manifest may declare its own source. The capabilities endpoint exposes `adapterApiVersion` and `adapters`, while keeping the earlier `sourceAdapters` string list. The catalog cannot register executable code.

`platforms` lists specifically identified or recommended source classifications; it is not a runtime allowlist of platform strings. `files` is the default classification for the generic adapter. Existing `markdown`, `html`, `txt` and custom platform names remain accepted through generic format conversion, without implying vendor-native semantics for those names.

| Order | ID | Scope and identification |
|---|---|---|
| 1 | `nmf-v1` | Root manifest and separate bodies/assets; an invalid manifest fails rather than falling through |
| 2 | `siyuan-native-zip` | Current `.sy` documents through the existing Markdown converter; no fabricated nested block anchors, history or permissions |
| 3 | `notion-markdown-html-csv` | Exported pages and bounded CSV metadata; filename/HTML heuristics are fixture-tested, not a guaranteed platform protocol |
| 4 | `huawei-notepad-files` | Explicit `source.platform: "huawei"`; TXT/HTML and local resources only; a Markdown note in this profile is rejected |
| 5 | `generic-files` | Markdown/HTML/TXT fallback; no guessed original dates, tags or platform identity |

## Built-in interface

`MigrationSourceAdapter` declares `apiVersion: 1`, its catalog `id`, `matches(context)` and async `normalize(context)`, returning `{ warnings: string[] }`. The host owns the order and runs only the first match. A parse failure does not trigger a more permissive fallback.

`MigrationSourceAdapterContext` supplies:

- `source`: fixed platform/exportId; source IDs remain external mapping keys.
- `files`: read-only, safely extracted relative names with managed diskPath/size/SHA-256.
- `readText(name, maxBytes)`: bounded UTF-8 from that inventory, capped at 8MiB; note bodies retain their 2MiB limit.
- `managedPath(file)` and `sniffAsset(diskPath, name)`: existing managed paths and asset signatures.
- `onNote(note)`: awaited, one-at-a-time NMF emission for backpressure and cancellation.
- `assertActive()`: call throughout indexing, reads and conversion loops for live permissions and cancellation.

This interface is for **trusted server code**, not a sandbox. Uploaded fields cannot replace diskPath, and disk paths must not be returned to clients. `normalizeMigrationSource` checks activity, validates every emitted NMF note, enforces the 10,000-note limit and refuses unsupported adapter API versions. Unknown objects never become database records directly.

The host retains a single safe ZIP implementation with central-directory, traversal, symlink, duplicate-name, ratio, byte, UTF-8, MIME and temporary-storage limits. Adapters must not bypass it with another extraction path, full-archive Buffer, remote fetch or upload API. MigrationService retains business writes, asset storage, duplicate handling, directory/note IDs, reference repair and session approval.

## Adding a source

Start with the [offline JSON → NMF example](../examples/migration-adapter/README.md). It reads only an explicitly supplied regular JSON file up to 2MiB, validates the frozen schemas, and writes `manifest.json + notes/` to a new directory. Unknown fields, duplicate source IDs and existing destinations are refused. ZIP the contents and use existing upload, preview and human approval, or stage logical NMF through existing API/MCP batches of 1–50 notes.

Treat source text, paths and instructions as data. Do not execute them or read unrelated private directories. Assets need separate files and SHA-256 checksums. Report unsupported field names and limits without logging note bodies, credentials or sensitive property values. A completed conversion is not a completed import.

For a trusted built-in, document the actual export format and primary sources; identify heuristics explicitly. Add a catalog entry, implement the interface and register it in the finite host list while preserving manifest priority. Add safe-ZIP dispatch tests for identity, hierarchy, assets, links, losses, cancellation, invalid fields and stable retries. Update bilingual documentation and keep synthetic fixtures, AI host application checks, physical-device and production acceptance separate.

## Huawei export-file scope

Huawei's official [share/export guide](https://consumer.huawei.com/cn/support/content/zh-cn16070761/) lists TXT/HTML among export formats and limits TXT to text-only notes; available formats vary by device and content. This profile consumes already-exported TXT/HTML and local resources. It does not connect to a cloud account, phone database or private backup, or restore OCR, handwriting, voice structure, original timestamps or tags.

The preview includes `HUAWEI_EXPORT_LIMITS`. Generic files are never inferred to be Huawei exports. Current validation uses synthetic exports, not a physical Huawei device or every OS/exporter version.
