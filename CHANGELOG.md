# 更新日志 / Changelog

本文档由 `scripts/generate-changelog.mjs` 从 git commit（Conventional Commits）自动生成，并在每次
`scripts/release.sh` 发版时追加新版本。手写修订同样欢迎——发布脚本只会在文件顶部的占位标记下方
追加新版本条目，已有内容不会被改写。

格式说明：

- 每个版本一个二级标题：`## vX.Y.Z - YYYY-MM-DD`
- 条目按类型分组：新增 / 修复 / 优化 / 文档 / 重构 / 其他
- Commit 以 Conventional Commits 为规范（feat / fix / perf / refactor / docs / chore / style / test / build / ci）

<!-- ADD_NEW_HERE -->

## v1.4.1 - 2026-07-17

### 📝 文档

- design markdown live preview image auth fix (eaf611e)

### 🤖 CI

- remove temporary PostgreSQL access/session validator (abec8f3)
- temporarily validate PostgreSQL access and sessions (38251e6)

### 📌 杂项

- fix preserve protocol-relative markdown images (c394870)
- fix markdown live preview attachment images (13f5822)
- fix notebook export attachment auth (9bd3dd8)
- fix clipboard copy (03b2c68)
- fix notebook publication routes (5b02e06)


## v1.4.0 - 2026-07-17

### 🐛 修复

- **db**: migrate share comment source fields before indexing (ee86795)

### 📝 文档

- **db**: plan share comments migration fix (080b955)
- **db**: document share comments migration fix (7cbaf4e)


## v1.3.9 - 2026-07-17

### 🐛 修复

- **release**: 发版前校验环境与登录状态 (bb7879a)

### 🤖 CI

- remove temporary PostgreSQL permissions validation (e4dd96e)
- add temporary PostgreSQL permissions validation (91fbc00)

### 🔧 其他

- **ci**: remove temporary PostgreSQL batch B validator (162d9f6)
- **ci**: expose latest PostgreSQL validation result (fa02ec7)
- **ci**: validate PostgreSQL unified batch B (4939808)


## v1.3.8 - 2026-07-17

### ✨ 新增

- **sdk**: attach binary APIs to NowenClient (#148) (f593438)
- **cli**: register attachment commands (#148) (aacd8b8)
- **cli**: add attachment commands (#148) (44de067)
- **cli**: add attachment client (#148) (9324c04)
- **sdk**: export attachment client (#148) (72a2f58)
- **sdk**: expose attachment API client (#148) (52e809a)
- **share**: publish runtime origin to all link builders (#318) (c588191)
- **share**: share runtime origin across all public links (#318) (6f0b018)
- **share**: let admins configure public origin in modal (#318) (1e3fe19)
- **share**: load runtime public origin into site config (#318) (1302344)
- **share**: resolve and explain public link origin (#318) (69e851c)
- **share**: expose runtime public origin setting (#318) (13978dd)
- **share**: resolve runtime public web origin (#318) (4e08054)
- **sync**: serialize versioned note updates (#319) (3fdb7f0)
- **sync**: add latest-only versioned save queue (#319) (488b7dc)
- **import**: route Word imports through safe worker pipeline (#76) (1bf4059)
- **import**: mount global DOCX import center (#76) (241c24d)
- **import**: add DOCX progress, cancel, and retry center (#76) (9871562)
- **import**: add verified attachment-backed DOCX import (#76) (b8061fe)
- **import**: add cancellable DOCX import task coordinator (#76) (3e0df44)
- **import**: parse DOCX files off the main thread (#76) (7903d0b)
- **import**: add DOCX safety and integrity guards (#76) (dfacd40)
- **import**: embed WeChat favorites export guide (340d6bb)
- **import**: restructure import hub sources (#310) (a302b86)
- **sharing**: complete sharing management workflows (#308) (63d483e)
- **workspace**: reuse emoji picker in admin workspace editor (#309) (d922f58)
- **workspace**: select emoji icons in create and edit dialogs (#309) (39dca86)
- **workspace**: persist and broadcast emoji icons (#309) (251e4b5)
- **workspace**: add reusable emoji icon field (#309) (ca02760)
- **workspace**: validate emoji workspace icons (#309) (5a4e789)
- **db**: add imported note origin mapping schema (#303) (ea125ee)
- **import**: expose WeChat favorites in migration hub (#303) (5abe02d)
- **import**: add WeChat favorites import UI (#303) (922a05a)
- **import**: add WeChat favorites import client (#303) (d1543d1)
- **import**: mount WeChat favorites package endpoint (#303) (27e7791)
- **import**: add streaming WeChat favorites import route (#303) (8ca32e8)
- **import**: implement WeChat favorites package import (#303) (c07e442)
- **import**: add WeChat favorites package adapter (#303) (fd2b3f2)
- **import**: expose Obsidian Vault migration in data manager (#195) (e642299)
- **import**: add Obsidian Vault import UI (#195) (c80175a)
- **import**: import Obsidian notes and attachments (#195) (dde475e)
- **import**: resolve and rewrite Obsidian attachment links (#195) (5171cae)
- **import**: scan Obsidian folders and ZIP archives (#195) (b6e238a)
- **import**: add Obsidian path and media helpers (#195) (8c524be)
- **import**: add Obsidian import data model (#195) (b4346b2)
- **knowledge**: complete backlink UX, graph and block embeds (#165) (e9d86e0)
- **editor**: localize remote images and warn on risky paste colors (#302) (863544e)
- **knowledge**: add universal block links and MCP block tools (#165) (6381781)
- **postgres**: add API token resource scope schema (b92015e)
- **mcp**: wire knowledge tool scope context (31b20bb)
- **mcp**: inject notebook scope into knowledge tool (f95cf6d)
- **mcp**: allow notebook-scoped knowledge ask (fdb65fb)
- **settings**: manage token notebook resources (31bbc7e)
- **auth**: mount API token resource enforcement (721292f)
- **tokens**: manage notebook resource grants (f2cd75a)
- **auth**: persist API token resource mode (07202f0)
- **auth**: enforce API token notebook resources (4a5aef7)
- **mcp**: enable scoped token entrypoint (ed359a3)
- **mcp**: enforce scoped token requests (8cf351b)
- **mcp**: add notebook scope policy (d186155)
- **publication**: surface public space in signed-in workspace (#215) (9fe3bae)
- **publication**: add signed-in public-space entry (#215) (6fb4de3)
- **audit**: classify notebook publication events (#215) (c21c211)
- **publication**: mount public knowledge-space routes (#215) (5cf1fe8)
- **publication**: expose public modes and directory permissions (#215) (946ceb2)
- **publication**: add public notebook knowledge-site view (#215) (7cb3bd7)
- **publication**: add notebook publishing API client (#215) (7a6d8ad)
- **publication**: activate notebook publishing routes (#215) (ea3f70a)
- **publication**: add public notebook publishing and directory ACL (#215) (b344923)
- **permissions**: support directory comment and manage overrides (#215) (00df2fd)
- **permissions**: inherit notebook ACL through directory tree (#215) (d153519)
- **publication**: authorize notebook publication attachments (#215) (a6bb1e8)
- **code-block**: load wrapping overrides (#287) (98289a3)
- **code-block**: enable automatic line wrapping (#287) (0b4ed2d)
- **ai**: resolve AI settings by user (482e572)
- **ai**: add per-user AI settings storage (ec45751)
- **backup**: activate automatic full backups (#291) (7d07948)
- **backup**: make automatic backups attachment-safe (#291) (05b6463)
- **ai**: mount embedding settings in AI preferences (d01e31d)
- **ai**: add embedding settings panel (f86b5b3)
- preserve SiYuan custom icons on import (#245) (a033eec)

### 🐛 修复

- **cli**: normalize attachment query typing (#148) (ae21ad6)
- **sdk**: normalize attachment query typing (#148) (9474c03)
- **editor**: resolve list rendering regressions (#322) (c3a93e2)
- **export**: preserve native Markdown in single-note exports (#320) (4d826ea)
- **tasks**: 修复任务详情模块编译错误 (4909726)
- **share**: warn when public links use protected origin (#318) (7061e18)
- **sync**: install per-note update serialization (#319) (d212ede)
- **editor**: install global NodeView mutation guard (#317) (8d7ae28)
- **editor**: guard all NodeView mutations in read-only mode (#317) (223e21f)
- **editor**: enforce code block read-only toolbar permissions (#317) (c64e6ab)
- **editor**: block code dissolve transactions in read-only mode (#317) (49d251f)
- **editor**: define code block read-only action policy (#317) (3cd02e7)
- **tasks**: save custom repeat rules with current values (#315) (ef3ec24)
- **tasks**: install task update safety bridge (#315) (2601594)
- **tasks**: normalize repeat requests and surface update failures (#315) (1397c9c)
- **tasks**: centralize custom repeat rule construction (#315) (98029a1)
- **import**: return void from DOCX progress cleanup (#76) (88c2dde)
- **import**: keep DOCX worker compatible with bundled JSZip types (#76) (51871b4)
- **import**: accept optional normalized format snapshot (#76) (1993ffe)
- **import**: tolerate block whitespace during DOCX verification (#76) (b90686c)
- **import**: verify normalized DOCX persistence safely (#76) (55bae5b)
- **import**: distinguish DOCX semantic and persistence checks (#76) (7818bfa)
- **export**: normalize image export timestamps as UTC (#314) (94d03b8)
- **export**: preserve wide table columns in note images (#312) (b2d4d61)
- **editor**: stabilize outline heading navigation (#313) (0d6dc30)
- **editor**: keep table and text bubble menus mutually exclusive (#311) (8962262)
- **sharing**: keep counted sessions valid at view limit (#308) (020cf60)
- **sharing**: enforce share security and lifecycle (#308) (942236a)
- **sharing**: enforce public notebook read-only permissions (d74015c)
- **ci**: fetch issue 165 branches with explicit refspecs (2764eb7)
- **ci**: source issue 165 patches from preserved branch (19098dd)
- **ci**: apply issue 165 on latest main tree (51cdf41)
- **editor**: make issue 302 patch resume from diagnostics (d462dd9)
- **ci**: capture issue 165 patch failures (c727bd6)
- **knowledge**: preserve markdown block links and HTML notes (#165) (3b8fccb)
- **knowledge**: correct block idempotency and shared test fixture (e44705e)
- **knowledge**: align issue 165 migration and backlink types (6aad2f8)
- **knowledge**: structurally rewrite backlink excerpt patch (56e23ab)
- **knowledge**: correct backlink panel patch nesting (beb91e5)
- **knowledge**: normalize content format block patch spacing (0632b2b)
- **knowledge**: repair issue 165 client fixer syntax (eae9f06)
- **knowledge**: make issue 165 MCP search patch structural (cbc28cc)
- **editor**: preserve async insert position after dividers (#301) (7075187)
- **auth**: preserve compatibility and restricted boundaries (62b5af4)
- **test**: initialize token scope fixtures without top-level await (24a193a)
- **frontend**: include ES2022 library typings (1717ff1)
- bug (2a63fbf)
- **tasks**: 排除已删除任务的统计动态 (a8b402b)
- **frontend**: 使用 pdf.js 预览 PDF 附件 (ac543eb)
- **frontend**: 修正公开笔记本预览导入 (fcd42ef)
- **notes**: 保持置顶分组手动排序一致 (ff22434)
- **publication**: normalize public note formats and server URLs (#215) (d418b63)
- **publication**: keep public reader build-safe and responsive (#215) (11e84f8)
- **frontend**: 修正浏览器定时器类型 (9f4952c)
- **notes**: 同步置顶笔记到所有视图 (f3eba84)
- **ai**: normalize embedding fallback values (6a0c6d0)
- **ai**: prevent embedding queue starvation (e4948e0)
- **ai**: preserve defaults and safe migration boundaries (b86cab9)
- **ai**: isolate task and embedding configuration (137ef94)
- **editor**: 恢复视频控件交互 (9bdd0ef)
- **ai**: isolate settings and profiles by user (db28ef2)
- **backup**: avoid private-member typing in runtime tests (#291) (3c4439a)
- **backup**: keep automatic full-backup patch type-safe (#291) (d837416)
- **notebooks**: cover legacy parent updates in reconciliation (#211) (7e21011)
- **notebooks**: activate database tree guards (#211) (dc16019)
- **notebooks**: enforce tree integrity at database boundary (#211) (21756a9)
- **notebooks**: reconcile tree and note scope after moves (#211) (52ffb73)
- **notebooks**: invalidate tree after confirmed moves (#211) (902c411)
- **notebooks**: add authoritative tree invalidation event (#211) (6b1dcec)
- align SiYuan imported previews (#284) (a6f98e7)

### ♻️ 重构

- **sdk**: use public client entry (#148) (20ec838)
- **share**: keep origin resolver storage-lazy (#318) (f176a26)
- **import**: align Youdao component name (#310) (697a021)
- **import**: preserve Youdao folder importer alongside Obsidian (#195) (f01b405)

### 📝 文档

- **attachments**: document SDK and CLI workflows (#148) (a281a2b)
- **docker**: expose runtime public share origin (#318) (87e445b)
- **import**: write complete WeChat Favorites export tutorial (109a125)
- **import**: document WeChat favorites migration (#303) (82cde11)
- **mcp**: update for server token resource scopes (8feb232)
- **mcp**: document server-enforced token resources (a2aaaf0)
- **mcp**: document token notebook scopes (38c5e13)
- 添加删除任务动态过滤实现计划 (06bce80)
- 记录删除任务动态过滤设计 (3237f9d)
- 添加置顶实时重排实现计划 (d1f4708)
- 设计置顶笔记实时重排 (6d6c894)
- 规划视频控件事件修复 (0f86e91)
- 设计视频控件事件隔离 (ba2f33a)
- align AI isolation migration version (fcdec71)
- 规划用户 AI 配置隔离 (eb6dad0)
- 设计用户 AI 配置隔离 (4bc5a77)

### 💄 样式

- **share**: use supported warning background opacity (#318) (7bbcd8b)

### ✅ 测试

- **sdk**: add attachment contract test script (#148) (ace8a96)
- **sdk**: cover attachment API workflows (#148) (3f20048)
- **share**: cover shared runtime origin registry (#318) (21b760c)
- **share**: cover runtime public origin priority (#318) (8418ad8)
- **share**: cover public web origin resolution (#318) (837065b)
- **sync**: cover latest-only versioned save queue (#319) (cad79e9)
- **editor**: cover global NodeView read-only guard (#317) (7b24051)
- **editor**: type code block transaction regression (#317) (ab83581)
- **editor**: cover code block read-only mutations (#317) (19ff130)
- **tasks**: verify repeat payload object at API boundary (#315) (89ba532)
- **tasks**: cover custom repeat current-value regression (#315) (1ec4d58)
- **import**: cover safe DOCX conversion and integrity (#76) (9fd3d43)
- **export**: cover UTC image export timestamps (#314) (e1f2d96)
- **workspace**: cover emoji icon validation and permissions (#309) (12e464a)
- **import**: initialize WeChat import schema after test DB setup (#303) (a61bf6c)
- **import**: cover WeChat favorites adapter and idempotency (#303) (62248b0)
- **import**: cover Obsidian paths and attachment rewrites (#195) (f01f21e)
- **editor**: record issue 302 implementation diagnostics (146ed9b)
- **knowledge**: update issue 165 implementation diagnostics (d854162)
- **knowledge**: record issue 165 implementation diagnostics (fb2d972)
- **editor**: record issue 301 fix diagnostics (988c8c3)
- **auth**: record final token boundary validation (066d695)
- **auth**: cover restricted boundaries and legacy compatibility (40f38ab)
- **mcp**: record Phase 2-3 revalidation (0e04395)
- **mcp**: record final Phase 2-3 validation (bab2dc5)
- **auth**: cover API token notebook resource enforcement (042881f)
- **mcp**: record Phase 2-3 validation (5fe8965)
- **mcp**: cover notebook scope policy (49e3003)
- **tasks**: 确保初始化失败时清理临时库 (a09e362)
- **tasks**: 确保活动路由测试清理临时库 (724888f)
- **tasks**: 复现删除任务动态残留 (1dbd71a)
- **permissions**: cover inherited directory ACL overrides (#215) (1c52a8c)
- **editor**: 覆盖视频 NodeView 事件链 (1fbb2aa)
- **backup**: cover automatic full backup retention (#291) (91a0a87)
- **notebooks**: cover confirmed tree invalidation (#211) (b0f5763)
- **notebooks**: cover root moves and tree safety (#211) (e97d78e)

### 🔧 其他

- **ci**: remove temporary PostgreSQL unified validator (6d74d2b)
- **ci**: validate packaged PostgreSQL parity migration (a2f46df)
- **ci**: trigger PostgreSQL validation by PR command (7711dd4)
- **ci**: report PostgreSQL unified validation to PR (b59a230)
- **ci**: trigger unified PostgreSQL validation on PR edits (8d25c2b)
- **ci**: validate PostgreSQL unified branch (10b138d)
- **issue-322**: expose validation diagnostics (643542a)
- **issue-322**: use PR event runner (34586ec)
- **ci**: execute issue #322 migration (19c5501)
- **issue-322**: register deterministic runner (813315d)
- **issue-322**: add deterministic main migration (29eeff0)
- **ci**: run issue #322 implementation (6a5e883)
- **ci**: simplify issue #322 runner (bf55ed8)
- **ci**: diagnose issue #322 patch application (7356a38)
- **ci**: enable issue #322 command trigger (f1a4ca8)
- **ci**: apply issue #322 on main (ac79974)
- **issue-322**: stage regression tests (e349bc7)
- **issue-322**: stage export css patch (9601917)
- **issue-322**: stage list css patch (6aa4686)
- **issue-322**: stage editor patch (afee353)
- **ci**: remove issue 320 trigger (a3279c8)
- **ci**: remove unused issue 320 workflow (88adfa5)
- **ci**: allow PR-triggered issue 320 validation (b719f6d)
- **ci**: trigger issue 320 validation (1062bd8)
- **ci**: add one-shot issue 320 validation (0dcf096)
- **ci**: remove issue 319 trigger file (78b8f8c)
- **ci**: remove issue 319 trigger workflow (bd52153)
- **ci**: remove issue 319 apply workflow (105751b)
- **ci**: trigger issue 319 validation (ab32d56)
- **ci**: add issue 319 workflow trigger (cb46f9e)
- **ci**: apply and validate issue 319 fix (e6a3554)
- **issue-76**: remove inactive validation trigger (c2e3c5e)
- **issue-76**: remove inactive validation workflow (9ca91f4)
- **issue-76**: trigger DOCX import validation (db4bf1b)
- **issue-76**: stage DOCX import validation (1823fd3)
- clean issue 314 trigger (b4199e4)
- remove unused issue 314 workflow (a4596d9)
- retrigger issue 314 implementation (96415d9)
- trigger issue 314 implementation (3ac3c8f)
- stage issue 314 validation workflow (bec45fe)
- stage issue 312 implementation (ff58fb5)
- trigger issue 313 implementation (18a53b7)
- stage issue 313 validation workflow (7ab80d1)
- **import**: validate inline WeChat favorites guide (69666e3)
- **import**: stage inline WeChat favorites guide (2de144a)
- **issue-311**: make fix validation observable (06991ea)
- **issue-311**: add deterministic bubble fix script (769914b)
- **issue-310**: remove final one-time workflow log (cd4cc86)
- **issue-310**: capture import hub migration failure (12624a7)
- **issue-310**: remove one-time validation workflow (276833b)
- **issue-310**: remove one-time migration script (23bc621)
- **issue-310**: remove duplicate-run diagnostic (73c46d5)
- **issue-310**: make migration validation observable (982d650)
- **issue-310**: run validated import hub migration (f151475)
- **issue-311**: run robust bubble fix validation (2b8a2b5)
- **issue-310**: stage import hub IA migration script (7abd873)
- **issue-311**: diagnose failed bubble fix run (b34dd49)
- **issue-311**: stage bubble menu fix validation (83332c4)
- **issue-311**: capture selection handler excerpt (be11521)
- **issue-311**: inspect editor selection handling (0cf94e0)
- **issue-308**: validate final share-session consistency (6f9f0f6)
- **issue-308**: stage final session-limit consistency fix (f714beb)
- **issue-308**: rerun sharing validation with public comment alignment (0aa8024)
- **issue-308**: align public comment form patch (301a1bf)
- **issue-308**: record sharing management validation failure (c0fe1c8)
- **issue-308**: rerun sharing validation with literal-safe patch (1b07238)
- **issue-308**: finalize literal type patch helper (6e4a9d3)
- **issue-308**: preserve literal escapes in type patch (0795544)
- **issue-308**: rerun sharing validation with fixed helper syntax (150422c)
- **issue-308**: fix scoped type patch syntax (d885d4a)
- **issue-308**: rerun sharing validation with scoped type patch (0577af3)
- **issue-308**: narrow share-link type patch (40c66f8)
- **issue-308**: validate sharing management implementation (4ca1af1)
- **issue-308**: preserve share-link repository async API (757754d)
- **issue-308**: stage sharing management implementation (6c98469)
- **issue-308**: rerun backend validation with migration repair (0bde7c5)
- **issue-308**: repair migration sequence for validation (cd44469)
- **issue-308**: record backend validation failure (54f551b)
- **issue-308**: rerun backend validation with type fixes (d79ed21)
- **issue-308**: fix validation type surfaces (f7acfc4)
- **issue-308**: rerun backend validation with publication alignment (2793b6b)
- **issue-308**: align publication scope patch (bf98a6f)
- **issue-308**: rerun backend validation with PG alignment (bee32cf)
- **issue-308**: align PostgreSQL patch markers (032e55d)
- **issue-308**: persist backend validation diagnostics (9f21e3f)
- **issue-308**: validate share security implementation (fe421d8)
- **issue-308**: stage share security implementation (786682f)
- **ci**: remove stale branch cleanup workflow (8aff574)
- **ci**: trigger stale branch cleanup (2c5181b)
- **ci**: add one-shot stale branch cleanup (4862936)
- **ci**: trigger public notebook read-only fix (aa63272)
- **ci**: stage public notebook read-only fix (d8f3068)
- **ci**: trigger validated issue 165 promotion (2706a3a)
- **ci**: promote validated issue 165 feature tree (9df14fd)
- **ci**: retry issue 165 explicit branch fetch (3f4289e)
- **ci**: rerun issue 165 from preserved patch branch (89d38c6)
- **ci**: run issue 165 against latest main (dd8838b)
- **ci**: retry repaired issue 165 normalizer (11dec1f)
- **ci**: retry escaped issue 165 patch (db2a42e)
- **ci**: retrigger issue 302 implementation (5368b5f)
- **ci**: resume validated issue 302 implementation (00e4382)
- **ci**: retry structural Markdown note-link patch (c31fdaa)
- **ci**: retry normalized issue 165 patches (47523f6)
- **ci**: retrigger issue 165 with patch diagnostics (91f0b9d)
- **ci**: trigger issue 165 remaining-feature runner (406a90a)
- **ci**: add issue 165 remaining-feature runner (3598316)
- **ci**: trigger issue 302 implementation (5975b56)
- **ci**: validate and apply issue 302 (73fc7a4)
- **editor**: add issue 302 implementation script (951999e)
- **ci**: trigger issue 165 markdown HTML follow-up (16c4d10)
- **ci**: validate issue 165 markdown and HTML follow-up (966260a)
- **knowledge**: add issue 165 markdown follow-up patch (9b576ea)
- **ci**: trigger final issue 165 validation (85c0cb9)
- **ci**: retry issue 165 final backend assertions (fda837f)
- **ci**: trigger compile-fixed issue 165 patch (c0000ca)
- **ci**: retry issue 165 after compile fixes (5a0b96b)
- **ci**: trigger structural issue 165 patch (d407eab)
- **ci**: retry issue 165 with structural client patches (9991aa4)
- **ci**: trigger backlink-corrected issue 165 patch (4a787a6)
- **ci**: retry issue 165 after backlink patch fix (f27e838)
- **ci**: trigger normalized issue 165 patch (d858666)
- **ci**: retry issue 165 after patch normalization (c63b127)
- **ci**: retrigger issue 165 implementation (95dc3c6)
- **ci**: retry issue 165 implementation workflow (37b2f7a)
- **ci**: trigger issue 165 implementation (7ee80a1)
- **ci**: add issue 165 implementation workflow (7dc8b37)
- **knowledge**: add issue 165 client patch script (b1f1c69)
- **knowledge**: add issue 165 backend patch script (c7aa293)
- **ci**: trigger deterministic issue 301 fix (fb06f09)
- **ci**: add deterministic issue 301 apply workflow (51ff88a)
- **editor**: add deterministic issue 301 patch script (1729a26)
- **ci**: trigger issue 301 fix diagnostics (178db0c)
- **ci**: add issue 301 fix diagnostics (5ce042c)
- **ci**: retrigger direct fix for issue 301 (8e8be29)
- **ci**: trigger direct fix for issue 301 (5b72769)
- **ci**: add direct main fix workflow for issue 301 (a438539)
- **ci**: trigger final token boundary validation (4871786)
- **ci**: add final token boundary validation (786e706)
- **auth**: remove completed compatibility workflow (2e59294)
- **auth**: remove completed compatibility trigger (f7f0167)
- **auth**: retrigger compatibility boundary patch (d6be5ff)
- **auth**: include restricted tag boundary patch (a53d065)
- **auth**: trigger unrestricted compatibility patch (9363753)
- **auth**: add one-shot unrestricted compatibility patch (2357cae)
- **ci**: trigger Phase 2-3 revalidation (2229dda)
- **ci**: add Phase 2-3 revalidation (429ea3f)
- **mcp**: remove completed closeout workflow (75e52c2)
- **mcp**: remove completed closeout trigger (8cf6790)
- **ci**: trigger final Phase 2-3 validation (1e505a9)
- **ci**: add final Phase 2-3 validation (a8e4707)
- **mcp**: retrigger Phase 2-3 closeout (134cb35)
- **mcp**: trigger Phase 2-3 closeout (7a181a4)
- **mcp**: add one-shot Phase 2-3 closeout patch (428da1e)
- **ci**: trigger Phase 2-3 validation (924bfb4)
- **ci**: add one-shot Phase 2-3 validation (c4150d5)
- **auth**: trigger token scope mount (ed3c4e8)
- **auth**: add one-shot token scope patch workflow (5d29f5f)
- **db**: remove temporary unified regression patch workflow (b0d679c)
- **db**: trigger unified regression patch from validation PR (303f405)
- **db**: patch unified migration regression conflicts (9528dcb)
- **db**: remove PostgreSQL unified branch bootstrap workflow (586016b)
- **db**: bootstrap unified PostgreSQL migration branch (3b30b7c)


## v1.3.7 - 2026-07-14

### ✨ 新增

- **标签栏**: 添加全部标签快速切换 (88ec3ac)
- **笔记体验**: 添加打印与紧凑侧栏布局 (e414baf)

### 🐛 修复

- **notebooks**: apply inherited sort to notes (6d6bfc5)
- **editor**: 全端关闭文档拼写检查（任务 1） (04ff8a4)
- 修复反代部署附件刷新后变成 127.0.0.1 裂图 (#295) (f02f14a)
- **export**: 延迟释放导出文件地址 (c243d06)
- **export**: 允许浏览器重试下载 (dfecf4f)
- **标签栏**: 完善标签列表收起与焦点行为 (e43ea81)

### 📝 文档

- 规划笔记排序继承修复 (eac2edc)
- 设计笔记排序继承修复 (e8b0ec2)
- 添加全端关闭拼写检查实现计划 (38de780)
- 设计全端关闭文档拼写检查 (b7d844e)
- **export**: 添加浏览器下载重试计划 (dbe91ba)
- **export**: 设计浏览器下载重试修复 (27b87ba)
- **计划**: 记录顶部标签快速切换实现步骤 (6706849)
- **设计**: 记录顶部标签快速切换方案 (31e4154)

### ✅ 测试

- **notebooks**: cover sidebar sort inheritance (96249db)

### 🔧 其他

- **git**: 忽略本地工作树 (15c73f0)


## v1.3.6 - 2026-07-14

### 🐛 修复

- 完成版本冲突处理闭环并停止重复弹窗 (#274) (b10c2cb)
- 简化全局同步状态，隐藏普通用户队列概念 (#275) (c222bfb)
- 修复安卓主题切换抖动与图片旋转缩放 (#270) (7510060)


## v1.3.5 - 2026-07-13

### ✨ 新增

- 用户偏好跟随账号同步 (#209) (1cc78c6)
- **移动端**: 优化图片操作菜单（任务 2/3） (bd6b701)

### 🐛 修复

- **Android**: 修复笔记列表轻触无响应 (f0ad5ce)
- **search**: rebuild stale FTS index on upgrade (#212) (1d1ab84)
- **search**: require explainable matches and cover metadata (#212) (a0bb18a)
- **search**: normalize literal query terms (#212) (8e32aeb)
- **移动端**: 提供 Markdown 预览入口 (b1da1f0)
- **Markdown**: 渲染行内与块级公式 (e70c612)
- **移动端**: 消除图片菜单切换闪烁 (04b3629)
- **移动端**: 兼容通用编辑器选区类型（任务 3/3） (ed0a91c)
- **移动端**: 保持图片操作菜单可见（任务 1/3） (3749ece)

### 📝 文档

- **移动端**: 记录图片菜单实现计划 (c633e03)
- **移动端**: 记录图片操作菜单设计 (c51c5fe)

### 💄 样式

- **移动端**: 缩小图片操作面板 (6f77dc6)

### ✅ 测试

- **search**: cover query normalization (#212) (b6168da)
- **search**: cover reliable full-text retrieval (#212) (ee6ddde)


## v1.3.4 - 2026-07-13

### 🐛 修复

- **桌面端**: 避免失效令牌登录循环 (e647d03)
- **附件**: 为上传与文件列表签发访问地址 (d51d603)
- **笔记**: 重命名时携带服务端版本 (69dbabe)


## v1.3.3 - 2026-07-13

### ✨ 新增

- **统计**: 重设计仪表盘概览 (14bd5ec)
- **sync**: expose failed queue diagnostics and retries (#208) (827bcd3)
- 思维导图折叠按钮显示子节点数量，移除 CSP 中的 frame-ancestors 限制 (6ed0f9c)
- **tasks**: 完善任务与习惯统计视图 (a77091a)
- **mobile**: install Android startup request coalescer (#237) (7804729)
- **mobile**: collapse Android cold-start reads (#237) (e795f05)
- **mobile**: mount compact startup snapshot (#237) (15f303f)
- **mobile**: add compact Android startup snapshot (#237) (c51286d)
- **导入**: 提升 H4-H6 标题级别保真 (4f98153)
- **export**: route image exports through reliable preview renderer (#221) (b717c6f)
- **export**: mount note image export center (#221) (2b11a07)
- **android**: add export file picker and native sharing (#221) (0289bc5)
- **android**: support gallery, files, share and open for exports (#221) (f231993)
- **export**: add cross-platform image export center (#221) (4bdb7b6)
- **export**: render faithful raster and SVG note exports (#221) (4eb4d15)
- **export**: add note image export request bridge (#221) (7e2e7a2)
- **desktop**: support multi-server profiles and safe NAS migration (#207) (3ebe73f)
- **siyuan**: 安全补齐导入保真并修复表格属性丢失 (#224) (6823598)
- **media**: enable attachment range responses (#214) (426ca86)
- **media**: mount mobile media experience bridge (#214) (c183e33)
- **media**: add mobile media picker and inline video UX (#214) (a4698a7)
- **media**: add mobile media selection helpers (#214) (f48e25e)
- **media**: report video upload lifecycle (#214) (5008cfb)
- **media**: report image upload lifecycle (#214) (bf828f7)
- **media**: expose per-file upload lifecycle (#214) (2314895)
- **media**: stream attachment video ranges (#214) (852f132)
- **media**: add strict single-range parser (#214) (9a76986)
- **android**: mount share import center (#220) (de83a1c)
- **android**: add system share import sheet (#220) (d5e43c5)
- **android**: build safe note content for shared items (#220) (a1f7498)
- **android**: expose native share import bridge (#220) (438f00a)
- **android**: register share and open-with targets (#220) (72e8dcb)
- **android**: route share intents into Nowen (#220) (0cab0a8)
- **android**: receive and stream shared files (#220) (a99f287)
- **android**: add share import validation helpers (#220) (08e38b6)
- **folder-sync**: add stop-tracking conflict control (#222) (bf80024)
- **folder-sync**: stop tracking edited notes on conflict (#222) (329e96b)
- **folder-sync**: expose detached conflict result (#222) (3546f3b)
- **folder-sync**: add stop-tracking conflict policy (#222) (3c04dd5)
- **folder-sync**: expose safety and conflict controls (#222) (f333ff9)
- **folder-sync**: process conflicts renames and source deletion (#222) (1648937)
- **folder-sync**: add conflict and deletion policies (#222) (c1d2b0f)
- **folder-sync**: harden incremental scanner and rename tracking (#222) (fb5f5dc)
- **folder-sync**: add conflict-aware transport (#222) (5a8547b)
- **folder-sync**: add advanced sync preferences (#222) (4c0c23d)
- **ai**: mount reliability UI shells (#218) (2a64b21)
- **ai**: add explicit manual configuration switch (#218) (33a7db5)
- **ai**: expose context modes and diagnostics in chat (#218) (d326db5)
- **ai**: add reliable ask client and diagnostics parser (#218) (0206e9e)
- **ai**: mount reliable context routes (#218) (ad20cf4)
- **ai**: add explainable reliable ask pipeline (#218) (621b0ed)
- **ai**: add explainable context preparation (#218) (216bf4f)
- **clipper**: persist image limits and reset account state (#217) (667c57f)
- **clipper**: expose lazy image limits and reset controls (#217) (aed4113)
- **clipper**: add quick note and target picker UI (#217) (a7646e2)
- **clipper**: redesign popup as unified capture entry (#217) (f50d15e)
- **clipper**: mount enhanced background entry (#217) (9aa1fce)
- **clipper**: implement unified quick note and clip pipeline (#217) (a8a282c)
- **clipper**: support workspace targets and note metadata (#217) (c2a9cab)
- **clipper**: define unified capture protocol (#217) (888bb2a)
- **clipper**: persist account-scoped capture preferences (#217) (933fe88)
- **clipper**: add bounded image localization pipeline (#217) (9a67963)
- **data**: mount full system transfer controls (ad0f6c3)
- **data**: replace database-only transfer with full system archive (ef4527f)
- **tasks**: enable image-aware transfer center (#206) (dd60910)
- **tasks**: expose full backup with task images (#206) (71969f1)
- **tasks**: add image-aware task backup archive (#206) (b8fb1f2)
- **tasks**: mount task data transfer center (#206) (08615b3)
- **tasks**: add responsive import export center (#206) (2b737ba)
- **tasks**: add task backup and import engine (#206) (e7a099c)
- **android**: mount mobile drawer UX bridge (7b56924)
- **auth**: mount persistent 2FA challenge center (#158) (3a3fe36)
- **auth**: add resilient 2FA challenge center (#158) (8d03e0a)
- **images**: 保留图片旋转/翻转状态并修复图片节点 inline 模式 (206344e)
- **updater**: mount desktop update center (#202) (8530330)
- **updater**: add global in-app update center (#202) (4be7f34)
- **updater**: add update presentation helpers (#202) (f6c76bb)
- **updater**: add consent-driven in-app update state machine (#202) (8e048b2)
- **images**: mount persistent editor transform bridge (#201) (86b712b)
- **images**: add compact editor transform controls (#201) (6579bf0)
- **images**: add persistent image transform attributes (#201) (00f30df)

### 🐛 修复

- **任务提醒**: 修复鉴权与路由匹配 (44640e0)
- **editor**: let IME composition commit through slash fallback (#213) (3884c83)
- **editor**: reset and scope slash command menu (#213) (53a8619)
- **editor**: make slash activation transaction-driven (#213) (de85615)
- **同步**: 改善冲突队列与删除后清理 (1535ba3)
- **tasks**: 加固任务统计历史与兼容性 (#244) (ebbd1c6)
- **sync**: keep queue replay compatible with CORS allowlist (#208) (9f48bf0)
- **sync**: report pending queue and refresh authoritative snapshot (#208) (d4954e4)
- **sync**: preserve failed queue items and serialize flush (#208) (f339f9f)
- **sync**: add stable mutation ids to queue replay (#208) (76f34f5)
- 下载附件时使用附件访问桥，确保跨域场景也能正确下载 (e7cbbac)
- **mermaid**: 禁用 htmlLabels 使用原生 SVG text，避免 DOMPurify 清空节点文字 (4c6d499)
- **markdown**: include H4-H6 in editor outline (#236) (b54c09a)
- **ai**: 优化 AI 连接测试逻辑，允许模型未返回文本时也判定连接成功 (b850f8a)
- **export**: install reliable download bridge (#235) (3005f79)
- **export**: bridge all browser exports to HTTP downloads (#235) (6a2fb32)
- **export**: enforce bounded requests and one-time cleanup (#235) (45853cb)
- **export**: add bounded reliable export routes (#235) (9cba9c4)
- **export**: harden reliable export jobs (#235) (b2683fc)
- **mobile**: coalesce NAS startup reads in mobile web (#237) (886d4b8)
- **导出**: 让 PDF 和 Word 使用真实下载地址 (6ca71fa)
- **导出**: 覆盖单篇笔记附件流式下载 (18e37a0)
- **导出**: 使用后端流式任务避免压缩卡在99% (c975d58)
- **sharing**: authorize shared note attachments (#216) (45b91f0)
- **media**: recover legacy video MIME for playback (#214) (48ac1c1)
- **media**: infer missing video MIME from filenames (#214) (de7ee48)
- **media**: type file picker cancel events (#214) (36ee1e9)
- **media**: keep byte-range responses uncompressed (#214) (6ec3c53)
- **media**: treat prevented editor drops as handled (#214) (1310dbb)
- **android**: reject untrusted MIME header injection (#220) (f8c87f7)
- **android**: preserve legacy note formats during share import (#220) (d5ac04d)
- **android**: guard missing share import plugin (#220) (04500c2)
- **android**: accept open-with intents without MIME (#220) (e5f5832)
- **android**: harden shared executable detection (#220) (3ce0596)
- **android**: neutralize shared raw HTML in markdown (#220) (be78ac9)
- **folder-sync**: store desktop attachments under userData (#222) (966c237)
- **folder-sync**: detach entries removed from configured scope (#222) (55bd20d)
- **folder-sync**: protect notes when sync scope narrows (#222) (c2e3e8d)
- **folder-sync**: normalize root-compatible double-star rules (#222) (4bc8cf0)
- **folder-sync**: persist rename metadata despite unchanged hash (#222) (ec1174a)
- **auth**: invalidate cached identity before issuing sessions (#223) (14cb276)
- **ai**: harden scoped retrieval and full-note budgeting (#218) (e0e63a0)
- **clipper**: migrate username-scoped capture preferences (#217) (cd96777)
- **tasks**: use safe PNG for missing-image placeholders (#206) (9d989ad)
- **tasks**: keep fallback marker type-safe (#206) (6a668e3)
- **tasks**: install missing-image backup fallback (#206) (95946e0)
- **tasks**: tolerate missing images during backup export (#206) (8ad94ad)
- **tasks**: refine task transfer UX and observer cost (#206) (a277746)
- **tasks**: harden task backup integrity and imports (#206) (f692bb3)
- **android**: improve drawer search and safe top controls (6b8e342)
- **notebooks**: narrow nested sort resolver type (#190) (496285c)
- **notebooks**: apply inherited sort to nested notes (#190) (d7ab88c)
- **notebooks**: inherit root sort through nested tree (#190) (e81eee3)
- **auth**: cap pending 2FA challenges at five minutes (#158) (d1a541c)
- **auth**: preserve safe redirect after 2FA login (#158) (61adc42)
- **auth**: avoid extra CORS headers in 2FA verification (#158) (ac65c07)
- **auth**: harden 2FA challenge storage access (#158) (bc5aa5e)
- **auth**: let pending 2FA bypass quick login (#158) (ea43acd)
- **auth**: persist pending 2FA login challenges (#158) (5b107ed)
- **search**: keep Android sidebar focus during search transition (#203) (8450bca)
- **search**: hydrate remounted sidebar from bridge state (#203) (dfa2cc8)
- **search**: restore query after sidebar remount (#203) (c9c98fe)
- **search**: unify mobile sidebar and full search state (#203) (379f33c)
- **search**: decouple sidebar input from synthetic events (#203) (691fe1c)
- **search**: add mobile sidebar search state bridge (#203) (2aec04f)
- **search**: keep IME fallback compatible with older webviews (#203) (639ba47)
- **search**: commit IME text without synthetic input loss (#203) (5a7a9e5)
- **search**: preserve IME composition in sidebar search (#203) (3c5fa6c)
- **import**: route siyuan zip by suffix (480bc77)
- **images**: keep drag resize aligned after rotation (#201) (298d37c)
- **images**: preserve transforms in markdown exports (#201) (1ecf1b3)
- **images**: keep legacy replacement payloads stable (#201) (f68f74e)
- **images**: avoid symbol-key type errors in transform bootstrap (#201) (7619a8a)
- **images**: preserve transforms when replacing images (#201) (fdd7703)

### ♻️ 重构

- **export**: fold hardening into compatibility service (#235) (4ecc794)
- **media**: reuse pure video MIME helper (#214) (9673d8b)
- **media**: isolate video MIME inference (#214) (8df5142)
- **ai**: preserve user preference routes for reliability wrapper (#218) (4807345)

### 📝 文档

- **统计**: 明确仪表盘重设计方案 (9e4898f)
- 设计同步冲突处理流程 (ba1d63e)
- **export**: document reliable note image export (#221) (8559a6b)
- **media**: document mobile image and video workflow (#214) (ab8f6f0)
- **android**: clarify pending share retention budget (#220) (c7bc35b)
- **android**: document system share import (#220) (a3c277f)
- **folder-sync**: document conflict detach behavior (#222) (efaa4a7)
- **folder-sync**: document safe one-way sync v2 (#222) (c62f8e1)
- **clipper**: document unified capture workflow (#217) (737f9c9)
- add image editor regression screenshot (46acaf4)

### 💄 样式

- **clipper**: polish unified capture popup (#217) (9edbdf2)

### ✅ 测试

- **editor**: 兼容新版文本输入回调 (dda9472)
- **editor**: cover repeated slash command activation (#213) (8f359dd)
- **sync**: cover queue races, preservation and idempotency (#208) (eecec45)
- **export**: cover reliable download compatibility bridge (#235) (fe3d24a)
- **export**: cover quotas and one-time downloads (#235) (5dde2cf)
- **export**: preserve legacy helper coverage (#235) (50fb353)
- **mobile**: cover compact startup filtering and sorting (#237) (affcccd)
- **export**: cover safe long-image and pagination planning (#221) (36c6188)
- **sharing**: stabilize shared attachment validation (#216) (847e56f)
- **media**: cover lazy repair of legacy video MIME (#214) (af07a2d)
- **media**: verify empty mobile video MIME normalization (#214) (d90863a)
- **media**: isolate video MIME helper coverage (#214) (9436220)
- **media**: cover mobile video MIME inference (#214) (130f6fb)
- **media**: cover mobile media preparation helpers (#214) (c37119b)
- **media**: cover strict HTTP range parsing (#214) (329fee3)
- **media**: cover attachment video byte ranges (#214) (c23d12d)
- **android**: cover malicious shared MIME metadata (#220) (84d7d56)
- **android**: cover legacy note formats and unsafe share text (#220) (96f53d8)
- **android**: cover disguised executable shares (#220) (9bb7d8d)
- **android**: align share filename normalization (#220) (b591e90)
- **android**: cover shared note content fidelity (#220) (947dcd3)
- **android**: cover shared file validation (#220) (0dfa305)
- **folder-sync**: cover Electron attachment storage path (#222) (aafe59a)
- **folder-sync**: cover exclusion scope matching (#222) (6c72f42)
- **folder-sync**: cover advanced preference normalization (#222) (e5b53a6)
- **folder-sync**: cover stop-tracking conflict flow (#222) (b0d2f0a)
- **folder-sync**: cover hash-stable source rename (#222) (59e9a39)
- **folder-sync**: preserve sync marker in manual edit fixture (#222) (31c4383)
- **folder-sync**: cover conflict and source deletion policies (#222) (c96edd0)
- **folder-sync**: cover safety rename and advanced preferences (#222) (f681515)
- **auth**: cover fresh session cache invalidation (#223) (e36c08e)
- **ai**: cover disabled configuration guard and restore (#218) (6a85b97)
- **ai**: cover full note conversion and visible truncation (#218) (e0324be)
- **notes**: cover attachment cleanup on permanent deletion (0eabf88)
- **tasks**: assert PNG placeholder bytes (#206) (1d1a711)
- **tasks**: stabilize missing-image fallback assertions (#206) (14352e2)
- **tasks**: cover missing-image export fallback (#206) (11b4519)
- **tasks**: cover image backup archive parsing (#206) (775212a)
- **tasks**: cover backup integrity and import rollback (#206) (19119c9)
- **tasks**: cover cyclic hierarchy and note-link warnings (#206) (56d5fdf)
- **tasks**: cover task backup CSV and validation (#206) (43b897e)
- **android**: cover drawer search completion and safe controls (e1fb200)
- **notebooks**: cover nested sort inheritance (#190) (82a00b2)
- **auth**: enforce five-minute 2FA challenge cap (#158) (e3a08e9)
- **auth**: cover persistent 2FA login challenges (#158) (346ee2b)
- **search**: cover sidebar remount state (#203) (260b269)
- **search**: cover mobile sidebar bridge routing (#203) (e818ce9)
- **search**: cover sidebar IME event routing (#203) (177de30)
- **updater**: cover update state presentation (#202) (c28a31f)
- **images**: cover transformed markdown exports (#201) (3b1ac4b)
- **images**: preserve transforms during replacement (#201) (24c86b3)
- **images**: cover persistent editor transforms (#201) (948c95b)

### 🤖 CI

- add one-shot PR 236 fix trigger (f4bcdd8)

### 🔧 其他

- **ci**: bootstrap issue 221 export integration (43ae00f)
- **media**: rely on DOM cancel event typing (#214) (41485f6)
- 更新浏览器剪藏插件0.2.0发布包 (2df0ab3)
- **clipper**: publish manifest 0.2.0 (#217) (51b564d)
- **clipper**: bump unified capture release to 0.2.0 (#217) (c1ccf3f)
- remove unused issue 201 verification workflow (1c7a092)
- remove unused issue 201 patch script (9b2a97d)
- apply and verify image transform implementation (#201) (9958f76)
- stage image transform implementation (#201) (01a4645)

### 📌 杂项

- 统一桌面开发与网页端本地数据源 (2652eb5)
- 修复桌面端本地登录后导航被拦截 (ce0384e)
- 修复本地迁移登录会话失效 (a239c5c)
- 修复桌面端原生模块 ABI 不匹配 (343270c)
- 修复客户端登录后个人笔记未加载 (4ab392f)
- 调整服务端入口至左侧导航栏 (9d2b5e3)
- 修复桌面端导航栏与窗口按钮重叠 (d10c3f6)
- 修复桌面端左上角展示和原生模块兼容 (1c28cfd)
- Add siyuan directory (bc3ada5)
- testability(media): export video MIME inference (#214) (4d15d0f)


## v1.3.2 - 2026-07-10

### ✨ 新增

- **images**: mount mobile and share image experience (#199) (553eb59)
- **images**: add compact mobile sheet and share lightbox controls (#199) (8a6a873)
- **images**: add mobile sheet and lightbox helpers (#199) (882614c)
- **markdown**: mount experience bridge (#198) (176894c)
- **markdown**: bridge live preview and split sync (#198) (37791f9)
- **markdown**: unify preview tasks code and anchors (#198) (95ee809)
- **markdown**: add block live preview extension (#198) (e2865b5)
- **markdown**: add mapped split scroll sync (#198) (befcd6b)
- **markdown**: add shared enhanced code block (#198) (15cb544)
- **sidebar**: replace notebook icon picker (#170) (3bd414a)
- **ui**: add searchable emoji picker with recents (#170) (2cf7066)
- **emoji**: add comprehensive local emoji dataset (#170) (fae2995)
- **markdown**: safely render imported HTML and sandboxed iframes (#196) (a9a3968)
- **ai**: mount AI profile switcher bridge (#197) (6ad8151)
- **ai**: manage multiple AI service profiles (#197) (8d9b583)
- **ai**: add chat profile switcher (#197) (e9f8fdd)
- **ai**: add AI profile client (#197) (bb76db1)
- **ai**: add reusable AI profiles and model discovery (#197) (a13e2c6)
- **search**: mount persistent search center (#166) (34327fa)
- **search**: return match counts and notebook metadata (#166) (7c1edef)
- **search**: add full-width search center (#166) (2dc53ea)
- **notes**: mount note icon feature bridge (#171) (fedc653)
- **notes**: add note icon picker and list rendering (#171) (f1fb17a)
- **notes**: add batched note icon client store (#171) (ed692a5)
- **notes**: add persistent note icon metadata API (#171) (b5859a9)
- **notes**: add rename action to note context menus (#172) (772e912)
- **notes**: add context menu rename dialog (#172) (c6276f8)
- **tasks**: add habit check-in module (#191) (18da154)

### 🐛 修复

- **build**: accept missing image action grids (ab2637d)
- **build**: narrow active note before rename update (eebee72)
- **sync**: mark only confirmed detail responses as cached (#200) (c6267b2)
- **sync**: preserve cache detail markers on metadata writes (#200) (02c848d)
- **sync**: preserve offline base fingerprints across queue acknowledgements (#200) (4676c75)
- **sync**: limit safety snapshots to destructive overwrites (#200) (fcb0401)
- **sync**: require complete server note responses (#200) (92a18a6)
- **sync**: require server identity fields for cached details (#200) (e27caa6)
- **sync**: reject list placeholders as note details (#200) (b216739)
- **sync**: distinguish cached details from list placeholders (#200) (2698bd0)
- **sync**: install complete note response guard (#200) (860ae6a)
- **sync**: reject incomplete update responses (#200) (065c8ae)
- **sync**: reject incomplete note detail cache writes (#200) (433fd17)
- **sync**: validate offline base content fingerprints (#200) (79f028b)
- **sync**: fingerprint offline note bases (#200) (1f1dd73)
- **sync**: finalize stale-base validation and conflict drafts (#200) (e6b2ffa)
- **sync**: mark identical draft rebases as conflicts (#200) (7b2b1e5)
- **sync**: preserve conflicted draft base revisions (#200) (86de7c0)
- **sync**: install revision safety trigger (#200) (a8a2e20)
- **sync**: preserve every overwritten note revision (#200) (204b67b)
- **sync**: install note write safety before render (#200) (4b22240)
- **sync**: guard stale and unconfirmed note writes (#200) (91b02ed)
- **sync**: stop blind conflict replays (#200) (68ca026)
- **sync**: distinguish offline note snapshots (#200) (fb97b2c)
- **markdown**: provide live block decorations from state field (#198) (7f23848)
- **images**: install mobile image focus guard (#199) (d1911d1)
- **images**: blur editor when mobile image sheet opens (#199) (3d71a49)
- **images**: use a strict-safe lightbox guard key (#199) (922912d)
- **images**: keep lightbox rotation during zoom (#199) (55a1480)
- **images**: preserve lightbox rotation across zoom updates (#199) (c52b8bc)
- **markdown**: align preview when split mode opens (#198) (1025238)
- **markdown**: stabilize bridge persistence and observers (#198) (2d2425e)
- **siyuan**: bound metadata scans and align document mapping (#196) (db045b5)
- **siyuan**: index assets referenced from imported HTML (#196) (1a47d2b)
- **siyuan**: preserve notebook order and emoji metadata (#196) (7f23f72)
- **siyuan**: preserve emoji and iframe nodes during markdown conversion (#196) (8975f9a)
- **ai**: preserve connection testing for profiles (#197) (fe0c164)
- **ai**: keep profile switcher compact on mobile (#197) (98e25a0)
- **ai**: normalize AI profile request headers (#197) (c6af9fe)
- **ai**: harden profile persistence and preserve icon validation (#197) (7be2687)
- **ai**: reload profiles when chat opens (#197) (d70b413)
- **android**: limit native bridge to JSON reads (d39b27a)
- **android**: install native-first API bridge (e690f83)
- **android**: prefer native HTTP for API reads (64ca208)
- **search**: preserve destination notebook after opening a result (#166) (8f06e93)
- **notes**: show rename in notebook tree context menu (e92279d)
- **notes**: make icon picker race-safe and keyboard friendly (#171) (1c25488)
- **notes**: recreate note icon table after database reset (#171) (e20e4b7)
- **habits**: respect read-only workspace permissions (816827a)
- **habits**: preserve history and validate check-in dates (b24db8c)
- **ui**: load global overlay layer contract (#192) (6558af4)
- **ui**: define settings modal overlay layer (#192) (9c56278)

### ♻️ 重构

- **siyuan**: preserve legacy import implementations (#196) (b243f34)
- **notes**: remove superseded note icon bridge (#171) (6f83dd2)
- **notes**: use stable note icon bridge (#171) (769d3a1)
- **notes**: make note icon DOM integration idempotent (#171) (c8314e8)
- **notes**: isolate note icon picker dialog (#171) (c5aa0db)

### 📝 文档

- add share lightbox control reference (cc4a0e7)
- add mobile image menu issue evidence (0a6653e)
- add live-preview reference screenshot for issue #198 (b1b7021)
- add code-block reference screenshot for issue #198 (e3e98ac)
- add task-list screenshot for issue #198 (16f4e4f)
- add screenshot for issue #198 (dd6853f)

### ✅ 测试

- **sync**: preserve same-revision offline fingerprints (#200) (01fcfd1)
- **sync**: exercise large-body shrink threshold (#200) (1a6d22d)
- **sync**: cover scoped destructive snapshots (#200) (dd804fd)
- **sync**: require identity fields in update responses (#200) (520a818)
- **sync**: require server identity fields for detail cache (#200) (52ca0c9)
- **sync**: distinguish cached details and placeholders (#200) (95f2dca)
- **sync**: reject incomplete cached note details (#200) (08defa4)
- **sync**: reject incomplete update acknowledgements (#200) (c4fa4f3)
- **sync**: cover same-version body mismatches (#200) (9d0fbdd)
- **sync**: use live timestamps for conflict drafts (#200) (e3e3400)
- **sync**: update optimistic-lock expectations (#200) (d5d3d01)
- **sync**: verify guarded note writes end to end (#200) (24582b3)
- **sync**: preserve draft conflict baselines (#200) (9cf3e71)
- **sync**: cover automatic pre-overwrite snapshots (#200) (2c8e376)
- **sync**: cover note write confirmation and conflicts (#200) (ca2ea5d)
- **sync**: prevent blind optimistic-lock replays (#200) (06198d4)
- **markdown**: cover live block decoration installation (#198) (bbbcf26)
- **images**: cover mobile image focus release (#199) (e068437)
- **images**: cover mobile sheet and lightbox navigation (#199) (17a39b9)
- **markdown**: cover tasks and enhanced code blocks (#198) (fd83cb3)
- **markdown**: cover mapped scroll interpolation (#198) (84eafd0)
- **emoji**: start issue 170 validation (c9f0b2d)
- **emoji**: cover categories search and recents (#170) (022a16c)
- **markdown**: isolate HTML preview globals (#196) (7d2c968)
- **markdown**: cover sanitized HTML and iframe rendering (#196) (6427be1)
- **siyuan**: cover order emoji HTML and iframe fidelity (#196) (e498496)
- **ai**: assert normalized profile request headers (#197) (237558f)
- **ai**: cover AI profile client (#197) (4f01866)
- **ai**: cover profiles and model discovery (#197) (24fd351)
- **android**: keep binary API reads on fetch (f4613cf)
- **android**: cover native-first API transport (7ac3627)
- **search**: cover match counts and result metadata (#166) (abf42df)
- **notes**: cover note icon metadata permissions (#171) (d84ec1f)
- **habits**: cover archived stats and validation regressions (2cce98d)

### 🔧 其他

- simplify question issue form (e53f492)
- simplify feature request form (0abd199)
- simplify bug issue form (74da975)
- remove unused issue 198 workflow (5a1256b)
- remove unused issue 198 codemod (b94f4c0)
- run issue 198 implementation and validation (bdd6c56)
- add one-shot markdown experience codemod (#198) (a119e85)
- remove issue 170 validation workflow (39f80a0)
- run one-shot sidebar emoji picker codemod (#170) (bd6960e)
- add one-shot sidebar emoji picker codemod (#170) (b8e759c)
- add usage question issue form (ba24df6)
- add structured feature request form (907cf41)
- add structured bug report form (6448da8)
- configure GitHub issue templates (38a408b)
- remove unused issue #171 PR workflow (37ac2b2)
- remove unused issue #171 apply workflow (26dc740)
- add one-shot PR trigger for issue #171 (659a4c2)
- apply issue #171 implementation (8743075)


## v1.3.1 - 2026-07-09

### ✨ 新增

- **editor**: 优化分屏拖拽 UI 并添加国际化支持 (b0fd101)
- **editor**: 支持分屏宽度拖拽调整、GFM任务复选框交互，优化标题保存逻辑 (96fe728)
- **editor**: 新增分屏拖拽和GFM任务复选框工具模块及测试 (da43c6f)
- **notebooks**: support drag reorder and per-level sort in notebook tree (50eeb2b)
- **notebooks**: add notebook tree sorting (c5b33ec)
- **tasks**: support delayed quick-add reminders (ff023b7)
- **editor**: add canvas image editor (62e627a)
- **editor**: add image action toolbar (a4e62b1)
- **tasks**: smart quick-add recognition (2e0ea40)
- **import**: safely preserve advanced Siyuan rich-text nodes (62e10c2)
- **import**: preserve Siyuan tables in rich-text import (19aab69)
- **import**: improve Siyuan rich-text tiptap fidelity (696e2c4)
- prompt for desktop data directory on first run (#168) (eab97d2)

### 🐛 修复

- **editor**: support line breaks in code blocks (d03a828)
- **editor**: copy image address with origin (c9e0852)
- **editor**: place image toolbar outside image (c179ae9)
- **editor**: keep note sort menu content aligned (327f392)
- **editor**: harden canvas image loading (57bf39c)
- **editor**: guard image replace target (f60fd65)
- **tasks**: require separators for smart recognition (a01d99c)
- 优化思源包导入服务与测试 (a88eb1f)
- guard siyuan zip entry and decompressed size budgets (4418a2c)
- add upload size limits for siyuan package import (891953a)
- keep backend bundle compatible with unzipper s3 helper (c3ed8c3)
- **import**: surface siyuan downgrade report and clean temp artifacts (9d81832)
- **import**: improve md rendering and downgrade reporting (a6c9781)
- **import**: support RT/MD siyuan media rendering (0305b28)
- **ci**: sync backend lockfile for npm ci (0b8551b)

### ✅ 测试

- cover backend siyuan package import (b5fe890)

### 🔧 其他

- 将开发期错误日志加入忽略列表 (84547a1)
- commit all local changes (b80bc3b)

### 📌 杂项

- 功能: 新增用户偏好设置接口与前端集成 (37a24b2)
- 功能: 接口层增加 Android 原生 HTTP 回退机制 (1a08701)
- 功能: AI 设置面板新增自定义 API 预设并优化 Ollama 预设 (8682237)


## v1.3.0 - 2026-07-07

_本版本无可展示的 commit 变更（可能全部是合并 / 工作流修改）_


## v1.2.9 - 2026-07-07

### ✨ 新增

- support custom desktop data directory (#168) (82babec)


## v1.2.8 - 2026-07-07

### ✨ 新增

- combine notebook tree expand toggle (5a283c6)
- add notebook tree expand collapse actions (#162) (add6eba)
- 标题输入框增加 IME 输入法状态感知，避免拼音串被误保存为标题 (9051ece)
- add browser-side size check and asset reference filtering for Siyuan import (fd6879a)

### 🐛 修复

- align notebook tree toggle icon state (3d37362)
- restore cross-device editor sync (da772b4)
- scroll markdown preview outline headings (#163) (b385fb9)
- support markdown default preview and siyuan callouts (#164) (4e94e0a)


## v1.2.7 - 2026-07-06

### ✨ 新增

- HTML 预览资源/大纲提取与编辑器联动优化 (8f46ae0)
- 任务重复/到期计算、导入导出、编辑器与任务面板优化 (25c6050)


## v1.2.6 - 2026-07-06

### ✨ 新增

- add EditorSplitView component (e574cbd)
- add NoteTabsBar and tab navigation system (b4dbfe9)
- add SiYuan SY parser and enhance import service (7d5d4c9)
- add SiYuan note import service (28cd137)

### 🐛 修复

- support manual note sorting (510bed7)
- 修复安全设置、任务中心及分享笔记等问题 (8f2565d)
- 优化登录页组件 (4c8be41)
- 优化登录页组件与国际化 (797be4c)
- 优化桌面端登录与导航组件 (539faf9)
- 优化Electron构建、日记中心及笔记列表 (865dc02)
- 优化笔记列表与标签页组件 (adec6f1)
- improve NoteTabsBar and AppContext integration (6a589a8)
- update Sidebar component (8b0ece9)
- update DataManager and i18n (aea3ac0)
- handle deleted notebooks in export/import flow (bf74ff9)
- enhance SiYuan import media asset handling (dd1d64a)
- improve SiYuan import service and i18n (ad29c60)


## v1.2.5 - 2026-07-03

### ✨ 新增

- 添加笔记本创建笔记功能 (6fe2abd)
- 添加任务日期 SQL 模块和附件 API 测试 (34b9ccd)
- add task calendar feed settings (6934d39)

### 🐛 修复

- 修复任务日历订阅带时间事件无法显示 (08b33b6)
- update Capacitor config (8ffe1a1)

### 📝 文档

- clarify arm64 docker and desktop support status (e59b3ee)

### 📦 构建

- add experimental linux arm64 desktop packaging entry (f86ff27)

### 📌 杂项

- Fix packaged app startup and client connectivity (f9befe7)


## v1.2.4 - 2026-07-02

### ✨ 新增

- source ICP filing from docker env (8eabf91)
- render database ICP filing on login page (6816e29)
- add ICP filing input in appearance settings (46f22a1)
- expose ICP filing site setting (f5deabd)
- add ICP filing setting (3dbfad6)
- add configurable ICP filing footer (15f7f53)
- copy personal notebooks to workspace (d06a70a)
- add rich text line height controls (86c5079)
- 添加Markdown视频预览与思维导图视口支持 (df167f8)
- support markdown preview in task details (df480f2)
- add postgres database adapter (PG-ADAPTER-02) (84acd7f)
- add database dialect helpers (PG-DIALECT-01) (aa6230b)
- add remaining async methods for task projects repository (FINAL) (6a9ef71)
- add remaining async methods for note links repository (C-A.5) (63fc2f1)
- add async replace links transaction for note links repository (C-A.4) (e7ca15a)
- add multi statement transaction support to sqlite adapter (C-A.1.1) (5fd016d)
- add async sort order update for task projects repository (C-A.3) (044500f)
- use executeBatch for system settings async setMany (C-A.2) (11e5ac9)
- add executeBatch to sqlite adapter (C-A.1) (5532f45)
- add bulk revoke and cleanup async methods for user sessions repository (B3-B2) (c7401a2)
- add revoke and list active async methods for user sessions repository (B3-B1) (bf4226a)
- add basic async methods for user sessions repository (B3-A) (bd3dc99)
- add async methods for workspace members repository (8d8bf12)
- **editor**: localize remote images on paste (PASTE-REMOTE-IMAGE-LOCALIZE-01) (296d138)
- **tasks**: add select all/deselect all in batch mode (0c1f688)
- **calendar**: schedule S3 export target refresh (TASK-CALENDAR-EXPORT-STORAGE-01-TIMER) (ffd5129)
- **calendar**: add S3 export target settings UI (TASK-CALENDAR-EXPORT-STORAGE-01-UI) (f343060)
- **say**: support markdown rendering in posts (SAY-MARKDOWN-INPUT-01) (87ff599)
- **calendar**: add S3 export target backend (TASK-CALENDAR-EXPORT-STORAGE-01-BE) (3bf11d5)
- **editor**: 点击块级引用后跳转到目标 heading 并高亮 (BLOCK-LINKS-JUMP-01) (b19b961)
- **editor**: [[ 引用时支持选择目标笔记标题块 (BLOCK-LINKS-UI-01) (ddebbb3)
- **db**: note_links 扩展块级引用支持 (BLOCK-LINKS-01) (b242e4c)
- **editor**: heading blockId 稳定生成 (BLOCK-ID-01) (1aaca83)
- **tasks**: lunar UI, i18n, tests (TASK-RECURRENCE-LUNAR-01) (1e39699)
- **tasks**: support lunar yearly recurrence (TASK-RECURRENCE-LUNAR-01) (9145328)
- **db**: add foreign keys to note_links table (NOTE-LINKS-FK-MIGRATION-01) (ba114d0)
- **backlinks**: add backlinks panel for note references (BACKLINKS-02) (d20df77)
- **tasks**: support custom recurrence rules (TASK-RECURRENCE-CUSTOM-01) (f3683f0)
- **tags**: auto-prune unused tags after note delete (TAG-PRUNE-UNUSED-ON-NOTE-DELETE-01) (8381830)
- **editor**: add note link reference with [[ trigger (BACKLINKS-01) (251666a)
- **journal**: add year-month archive view (JOURNAL-YEAR-MONTH-01) (056d651)
- **table**: improve mobile table editing toolbar (MOBILE-TABLE-EDITING-UX-01) (1c86d55)
- **journal**: add one-click today journal creation (JOURNAL-AUTO-DATE-01) (3cb743c)
- **table**: smart actions for phone numbers in table cells (TABLE-CELL-SMART-ACTIONS-01) (8c96fd9)
- **diary**: support custom publish date for moments (MOMENT-PUBLISH-DATE-01) (0929f08)
- **ui**: redesign diary layout with sidebar for desktop (SAYING-UI-DESKTOP-RV1) (e1dd92b)
- **auth**: add QR code for 2FA setup (AUTH-2FA-QR-01) (7eccea4)
- **tags**: multi-tag AND filtering (TAG-FILTER-MULTI-01) (c46aa33)
- add calendar button to sayings filter bar (SAYING-CALENDAR-PANEL-01) (6030714)
- **files**: show attachment folders in file manager (FILE-MANAGER-FOLDER-VIEW-01) (4806c17)
- show last saved time in editor sync status (SAVE-STATUS-LAST-SAVED-01) (831a060)
- file upload dialog with folder support (FILE-UPLOAD-DIALOG-FOLDER-01) (16e13e5)
- unify note creation menu in notebook tree (NOTE-CREATE-MENU-UNIFY-01) (90565ba)
- add collapsible code blocks (CODE-BLOCK-COLLAPSE-01) (8d2e682)
- add markdown note creation from notebook tree (NOTE-TREE-MARKDOWN-CREATE-01) (badb00e)
- group file manager attachments by notebook path (ATTACHMENT-DIRECTORY-ORGANIZE-01-E) (5d81115)

### 🐛 修复

- prevent title-only observer from freezing login (fabefcf)
- keep note list title toggle compact (8223b24)
- defer note list title-only observer until note list mounts (35e4a5a)
- load note list title-only mode with app bootstrap (17a812b)
- auto-start note list title-only mode (4969674)
- add note list title-only display mode (3cf78bc)
- **mcp**: create markdown notes with contentFormat (bd420d7)
- add issue 145 global UI guards (1db2eff)
- add issue 145 UI guard styles (f07fad9)
- allow larger custom font uploads (b80eb3e)
- prevent cached site settings on login page (dbf2b5a)
- persist and show ICP filing on desktop login (b533096)
- show database ICP filing on login page (ea16fbe)
- render database ICP filing on login page (97ad302)
- show ICP filing only on login page (a9a4aa7)
- keep ICP footer visible after login (b006428)
- preserve icp setting in settings responses (6583d57)
- refresh site settings on server url change (1fb54bf)
- disable mobile haptics and support pull refresh (2fa2c22)
- default ICP footer link when URL env is absent (ee35b46)
- rollback database when backup restore fails (b40fe16)
- show boot loading during remote startup (b76074e)
- move selected mind map nodes together (c9d95a6)
- use DOM hit testing for mind map selection (016c8aa)
- correct mind map selection hit testing (5b41888)
- make uploaded video previews compact (5e64fbc)
- support uploaded video previews in editor (431f4e2)
- harden note save conflict handling (7fdde21)
- improve note version history recovery flow (280f0e2)
- preserve content format in note version history (9c8e106)
- stop offline queue overwriting version conflicts (3837084)
- render markdown notes correctly when exporting images (88d4cf7)
- use sqlite string literal in task batch completion (ca49da5)
- resolve backend typecheck release blockers (b537dd2)
- repair user sessions SQL string quoting (f4b02ae)
- quote camelCase columns in folder sync files repository (929bf90)
- quote camelCase columns in embedding queue repository (2ee8837)
- quote camelCase columns in workspace invites repository (94b40e6)
- quote camelCase columns in task templates repository (8dd7af8)
- quote camelCase columns in task projects repository (1f9ade4)
- quote camelCase columns in calendar export targets repository (38e58e5)
- quote camelCase columns in api tokens repository (cca0b31)
- quote camelCase columns in share comments repository (2ca4ce2)
- quote camelCase columns in notebook share links repository (2a4ec85)
- quote camelCase columns in notebook members repository (42343b1)
- quote camelCase columns in user sessions repository (e66c3e2)
- quote camelCase columns in workspace members repository (813f706)
- quote camelCase columns in note versions repository (1b00230)
- quote camelCase columns in note links repository (b446abd)
- quote camelCase columns in attachment references repository (c58ef87)
- quote camelCase columns in tags repository (929efab)
- quote camelCase columns in note tags repository (5d9ef9d)
- quote camelCase columns in favorites repository (c8d2a29)
- quote camelCase columns in custom fonts repository (019e696)
- quote postgres camelCase column in system settings pilot (15622a2)
- **db**: fix null vs undefined type mismatch in share comments (DB-REPOSITORY-ACCEL-01-PARTIAL-FIX-BATCH-RV-FIX1) (be57e9a)
- **db**: migrate acl and notebook-permissions to repository pattern (DB-REPOSITORY-ACCEL-01-ACCEL-BATCH1) (18a4d3a)
- **db**: partial workspace members repository migration (DB-REPOSITORY-ACCEL-01-WORKSPACE-MEMBERS-FIX1) (7b675fe)
- **db**: complete share comments repository migration (DB-REPOSITORY-ACCEL-01-SHARE-COMMENTS-FIX1) (3a2477c)
- **db**: complete note versions repository migration (DB-REPOSITORY-ACCEL-01-NOTE-VERSIONS-FIX2) (95764c3)
- **db**: fix syntax error in workspaces.ts (DB-REPOSITORY-ACCEL-01-POST-B6-BULK-RV-FIX1) (c198729)
- **db**: complete task templates repository migration (DB-REPOSITORY-ACCEL-01-B-TASK-TEMPLATES-FIX1) (99b1589)
- **db**: complete note versions migration for users.ts (DB-REPOSITORY-ACCEL-01-B-NOTE-VERSIONS-FIX1) (31bc29c)
- **db**: complete notebook members migration for list and get operations (DB-REPOSITORY-ACCEL-01-B15-FIX1) (10d25b2)
- **db**: complete share comments migration for users.ts (DB-REPOSITORY-ACCEL-01-B16-FIX1) (17a4534)
- **db**: complete task attachments migration for data-file.ts (DB-REPOSITORY-ACCEL-01-B9-FIX2) (efe55d6)
- **db**: complete workspace members repository migration for users.ts (DB-REPOSITORY-ACCEL-01-B14-FIX1) (a7e34b8)
- **db**: add attachment references check methods (DB-REPOSITORY-ACCEL-01-B10-FIX1) (13635fc)
- **db**: add task attachments backup methods (DB-REPOSITORY-ACCEL-01-B9-FIX1) (baf2f1b)
- **db**: complete note yjs tables repository migration (DB-REPOSITORY-ACCEL-01-B11-B13-FIX1) (25175f2)
- **db**: complete workspace invites repository migration (DB-REPOSITORY-ACCEL-01-B6-FIX1) (b472637)
- **db**: complete mindmap folders repository migration (DB-REPOSITORY-ACCEL-01-B3-FIX2) (71446c4)
- **db**: complete folder metadata repository migration (DB-REPOSITORY-ACCEL-01-B3-FIX1) (fd6bf29)
- **build**: SEC-ELECTRON-01-E4.2 收敛 Electron 打包文件配置 (853c3ab)
- **security**: SEC-ELECTRON-01-E3.4 修正 meta CSP 兼容性 (66eaa7a)
- **security**: SEC-ELECTRON-01-E3.2 添加 CSP Report-Only 注入 (a1a6d19)
- **security**: SEC-ELECTRON-01-E2 添加权限请求拦截 (a23d5a1)
- **security**: add electron CSP meta policy (SEC-ELECTRON-01-E1-B1) (98d5ef0)
- **typecheck**: TYPECHECK-DEBT-01 清理预存类型错误 (e0d7903)
- **security**: harden folder sync file read boundary (SEC-ELECTRON-01-D4-B1) (3f65a25)
- **security**: SEC-ELECTRON-01-D3.2 收敛 PDF iframe sandbox 权限 (5b06d5f)
- **security**: SEC-ELECTRON-01-D3 附件预览安全 - PDF iframe sandbox + highlight.js DOMPurify (c83d3f7)
- **security**: SEC-ELECTRON-01-D4 folder-sync 扫描跳过 symlink 文件 (0298ebe)
- **security**: SEC-ELECTRON-01-D2 文件打开边界 - symlink 拒绝 + 路径脱敏 (6392325)
- **security**: SEC-ELECTRON-01-C-RV1 补齐 IPC 与 preload 双层校验 (f3925a7)
- **security**: SEC-ELECTRON-01-C IPC 与 preload 权限收敛 (c60888f)
- **security**: SEC-ELECTRON-01-B-RV1 sender 严格绑定 + setup IPC 校验 + 日志脱敏 (98a97c9)
- **electron**: deny window.open in data windows (SEC-ELECTRON-01-C-B2-B3) (7122e1b)
- **electron**: tighten main window navigation guard (SEC-ELECTRON-01-C-B1-FIX1) (3985aae)
- **electron**: guard main window navigation (SEC-ELECTRON-01-C-B1) (8b44ec7)
- **electron**: confirm before resetting local auth (SEC-ELECTRON-01-B2-B1) (ca3839c)
- **security**: SEC-ELECTRON-01-B Electron 最小高危修复 (1925304)
- **electron**: validate external URL protocols (SEC-ELECTRON-01-B1) (74feeba)
- **security**: SEC-XSS-01-E-RV1 parseVideoUrl 协议白名单修复 (e65c862)
- **security**: SEC-XSS-01-E Video iframe / Mermaid / KaTeX 安全兜底 (0cc0842)
- **security**: SEC-XSS-01-D 剪贴板粘贴 HTML 清洗 (1d712a6)
- **security**: SEC-XSS-01-C-RV1 CSP 生效位置修复 + data: 协议收紧 (c3f208a)
- **security**: 安全加固复审验收 (SECURITY-HARDENING-RV1) (f142992)
- **tasks**: 已完成任务的日期标签不再显示"已逾期" (e71c67b)
- **tasks**: remove duplicate batch route (TASK-BATCH-ACTION-500-01-RV2) (d9a5dd3)
- **tasks**: return safe errors for batch actions (TASK-BATCH-ACTION-500-01-RV1) (2c55e64)
- **tasks**: add comprehensive error handling for batch endpoint (d09cd25)
- **tasks**: add try-catch in batch complete to prevent 500 error (9f87408)
- **electron**: open associated markdown files directly (PC-MD-FILE-ASSOCIATION-OPEN-01) (960d461)
- **tags**: limit tag name length and truncate display (TAG-LENGTH-LIMIT-01) (7c736d2)
- **editor**: 修复 LaTeX 公式导致刷新后笔记内容丢失 (4a398b0)
- **editor**: replace HeadingItem with NoteEditorHeading in EditorPane (50d1f5f)
- **editor**: resolve HeadingItem type conflict in TiptapEditor (e529e4c)
- **calendar**: show absolute ICS subscription URL (BUG-CALENDAR-ICS-ABSOLUTE-URL-01) (6c66f11)
- **electron**: 修复 macOS ARM Traffic Light 按钮错位和拖拽问题 (e4afe02)
- **auth**: 退出登录时清除自动登录凭据 (c82c7c0)
- **journal**: 修复点击今日日记时 AnimatePresence 重复 key 警告 (bf992a9)
- **calendar**: correct S3 signing path for export targets (TASK-CALENDAR-EXPORT-STORAGE-01-BE-RV1) (ea5cfa4)
- **editor**: 显式引入 Link 扩展并配置 note: 协议 (BLOCK-LINKS-UI-01-RV3-LINK-PERSIST-DEEP-CHECK) (70b87ac)
- **editor**: 在 tiptapExtensions 中允许 note: 协议 (BLOCK-LINKS-UI-01-RV3-LINK-PERSIST-DEEP) (670cee0)
- **editor**: 允许 Link mark 使用 note: 协议 (BLOCK-LINKS-UI-01-RV2-LINK-PERSIST) (fc6e3e2)
- **diary**: prevent mood filter 'All moods' text wrapping (SIDEBAR-DIARY-SECTION-REMOVE-01) (6e76a21)
- **sidebar**: remove diary section from notes sidebar (SIDEBAR-DIARY-SECTION-REMOVE-01) (05380df)
- **db**: 添加 v39 迁移 (calendar-export-targets) (60c1d0f)
- **editor**: BLOCK-LINKS-UI-01-RV1 修复 triggerFrom 删除范围 (e8286be)
- **editor**: BLOCK-ID-01-RV1 修复 appendTransaction 和 schema 兼容性 (2445e20)
- **mindmap**: ensure schema for folders and reload list (BUG-MINDMAP-RELOAD-500-01) (d9352a1)
- **backlinks**: RV1 fixes for note_links cleanup and linkText (BACKLINKS-02-RV1) (be40897)
- **tasks**: prevent month/year overflow in custom recurrence (TASK-RECURRENCE-CUSTOM-01-RV1) (2118109)
- preserve viewMode context when pruning invalid selectedTagIds (TAG-PRUNE-UNUSED-ON-NOTE-DELETE-01-RV2) (dd52e9d)
- **tags**: cleanup invalid selectedTagIds after prune (TAG-PRUNE-UNUSED-ON-NOTE-DELETE-01-RV1) (678609e)
- **editor**: fix note link search and trigger position (BACKLINKS-01-RV1) (9677b0b)
- **tags**: refresh tags after note delete/trash (TAG-CLEANUP-ON-NOTE-DELETE-01) (9ddc763)
- **calendar**: support token-based public ICS subscription (TASK-CALENDAR-SUBSCRIBE-01-RV1) (09e1c6d)
- **journal**: add refresh token for archive data (JOURNAL-YEAR-MONTH-01-RV1) (0f11186)
- **table**: add toggleHeaderColumn and remove dead state (MOBILE-TABLE-EDITING-UX-01-RV1) (394dcc2)
- **journal**: change GET to POST and add unique index (JOURNAL-AUTO-DATE-01-RV1) (f01eb53)
- **diary**: desktop layout cohesion and visual noise reduction (SAYING-UI-DESKTOP-RV2) (2448059)
- **diary**: fix timezone offset in custom date (MOMENT-PUBLISH-DATE-01-RV1) (042d5a0)
- **share**: align image layout with editor rendering (BUG-SHARED-NOTE-IMAGE-LAYOUT-01) (2c18683)
- **files**: add missing ListView props in grouped view (FILE-MANAGER-TSC-DEBT-01) (69d97e9)
- **tags**: RV1 regression fixes for multi-tag filtering (TAG-FILTER-MULTI-01-RV1) (758a2a2)
- **i18n**: add diary calendar title translation (SAYING-CALENDAR-PANEL-01) (ed7f090)
- **desktop**: support api-only remote servers (BUG-DESKTOP-REMOTE-API-ONLY-01) (9af904e)
- **files**: show empty attachment folders in folder view (FILE-MANAGER-FOLDER-VIEW-01-RV1) (444c328)
- **files**: invalidate cache before refreshing after upload (BUG-FILE-UPLOAD-LIST-REFRESH-01) (4fa7522)
- **files**: update folderId on hash dedup hit (b188eff)
- **auth**: prevent account data leakage on user switch (13ddde0)
- **security**: prevent account data leak after switching users (AUTH-ACCOUNT-SECURITY-CACHE-01) (2e4bd36)
- extract parseServerTime to shared dateTime utility (NOTE-EXPORT-TIME-01-RV1) (5b890e1)
- parse backend timestamps as UTC in note export (NOTE-EXPORT-TIME-01) (0b2276c)
- **files**: deduplicate items to prevent repeated group rendering (cbde17b)
- use correct translation alias in MarkdownEditor status bar (MARKDOWN-EDITOR-RUNTIME-01) (2b85dc3)
- merge create note split-button into unified dropdown trigger (NOTE-LIST-NEW-MENU-01) (fc9783c)
- **files**: remove extra closing div causing JSX error (aaac0cf)
- **files**: toolbar layout regression - missing closing div + search overflow (a8e208b)
- **ui**: move storage badge inline with title in FileManager header (FILE-MANAGER-HEADER-UI-01) (98a5c8b)
- **editor**: markdown status bar char/word count display (0656e04)
- close unclosed div tag in FileManager.tsx (0cc6c94)
- remove duplicate ChevronDown import in FileManager.tsx (63c83e7)
- **files**: mobile layout + download compatibility (9239047)

### ♻️ 重构

- clean appearance settings after ICP removal (b078379)
- hide ICP input in appearance settings (08ac7f7)
- make ICP filing read-only site config (5a39fab)
- remove ICP filing from editable settings (cf1fd3b)
- hide global ICP footer outside login page (8ff2b24)
- define DatabaseAdapter interface (PG-ADAPTER-01) (5200851)
- **db**: add async methods for workspace members repository (B2-C) (93b7763)
- **db**: add async methods for note acl repository (B2-B) (53d2a01)
- **db**: add async methods for notebookMembersRepository (B2-A) (bf83c39)
- **db**: add batch 07 B1 remaining async repository pilots (32cd139)
- **db**: add batch 07 B1 async repository pilots (79e540e)
- **db**: add batch 06 A-level async repository pilots (8aa710d)
- **db**: add batch 05 A-level async repository pilots (decc07b)
- **db**: add batch 04 A-level async repository pilots (e432b63)
- **db**: add calendar export targets async repository pilot (DB-SQLITE-ASYNC-REPOSITORY-PILOT-BATCH-03-CALENDAR-TARGETS) (106c7af)
- **db**: add batch async repository pilots (DB-SQLITE-ASYNC-REPOSITORY-PILOT-BATCH-02) (90943d3)
- **db**: add custom fonts async repository pilot (DB-SQLITE-ASYNC-REPOSITORY-PILOT-02-CUSTOM-FONTS) (9fbf2b4)
- **db**: add sqlite async adapter pilot (DB-SQLITE-ASYNC-ADAPTER-PILOT-01A) (a8e1b54)
- **db**: add member query service pilot (DB-QUERY-LAYER-02-MEMBER-PILOT) (333f23c)
- **db**: add attachment query service pilot (DB-QUERY-LAYER-01-ATTACHMENT-PILOT) (c2d99cc)
- **db**: move embedding queue into repository (DB-REPOSITORY-ACCEL-01-B18) (548fd8d)
- **db**: move diary attachments into repository (DB-REPOSITORY-ACCEL-01-B17) (73d6e62)
- **db**: move share comments into repository (DB-REPOSITORY-ACCEL-01-B16) (b104973)
- **db**: move notebook members into repository (DB-REPOSITORY-ACCEL-01-B15) (27058fa)
- **db**: move workspace members into repository (DB-REPOSITORY-ACCEL-01-B14) (7f6c19c)
- **db**: move note Y-updates into repository (DB-REPOSITORY-ACCEL-01-B13) (2159237)
- **db**: move attachment chunks into repository (DB-REPOSITORY-ACCEL-01-B12) (0f1a355)
- **db**: move note Y-snapshots into repository (DB-REPOSITORY-ACCEL-01-B11) (9a7443e)
- **db**: move attachment references into repository (DB-REPOSITORY-ACCEL-01-B10) (9c1a1b5)
- **db**: move task attachments into repository (DB-REPOSITORY-ACCEL-01-B9) (58b6e56)
- **db**: move note ACL into repository (DB-REPOSITORY-ACCEL-01-B8) (e14cd19)
- **db**: move notebook share links into repository (DB-REPOSITORY-ACCEL-01-B7) (d4a1247)
- **db**: move workspace invites into repository (DB-REPOSITORY-ACCEL-01-B6) (8983d46)
- **db**: move task dependencies into repository (DB-REPOSITORY-ACCEL-01-B5) (1e546e4)
- **db**: move task calendar feeds into repository (DB-REPOSITORY-ACCEL-01-B4) (7960a2b)
- **db**: move folder metadata tables into repositories (DB-REPOSITORY-ACCEL-01-B3) (3138eb8)
- **db**: move task metadata tables into repositories (DB-REPOSITORY-ACCEL-01-B2) (9dec2e3)
- **db**: DB-REPOSITORY-ACCEL-01-B1 迁移 favorites + user_sessions Repository (90bddd7)
- **db**: move note_versions delete cleanup into repository (DB-REPOSITORY-NEXT-CANDIDATES-01-B2-B3) (a8ea3ae)
- **db**: move note_versions insert into repository (DB-REPOSITORY-NEXT-CANDIDATES-01-B2-B2) (db51d49)
- **db**: move note version reads to repository (DB-REPOSITORY-NEXT-CANDIDATES-01-B2-B1) (efe04bd)
- **db**: move ai custom prompts to repository (DB-REPOSITORY-NEXT-CANDIDATES-01-B1) (0b4ecf8)
- **db**: move note tag filtering to repository (DB-REPOSITORY-TAGS-COMPLETE-01-B2) (e119b38)
- **db**: move note tag links to repository (DB-REPOSITORY-TAGS-COMPLETE-01-B1B3) (c20eb53)
- **db**: move tag deletion to repository (DB-REPOSITORY-PILOT-NEXT-D1-C3) (4e1c810)
- **db**: move tag update to repository (DB-REPOSITORY-PILOT-NEXT-D1-C2) (d599f38)
- **db**: move tag creation to repository (DB-REPOSITORY-PILOT-NEXT-D1-C1) (54e4f57)
- **db**: move single tag query to repository (DB-REPOSITORY-PILOT-NEXT-D1-B) (7ce30c5)
- **db**: move tag list query to repository (DB-REPOSITORY-PILOT-NEXT-D1-A) (e38948d)
- **db**: move note link delete cleanup to repository (DB-REPOSITORY-PILOT-NEXT-C3) (10e1eff)
- **db**: move note link sync writes to repository (DB-REPOSITORY-PILOT-NEXT-C2) (68fa5c3)
- **db**: move note backlinks query to repository (DB-REPOSITORY-PILOT-NEXT-C1) (6edba78)
- **db**: migrate calendar export targets to repository (DB-REPOSITORY-PILOT-NEXT-B) (fb9bf88)
- **db**: add calendar export targets repository (DB-REPOSITORY-PILOT-NEXT-B) (73c1df9)
- **db**: route api token usage pruning through repository (DB-REPOSITORY-PILOT-02-C3) (cfe6fe3)
- **db**: route api token usage recording through repository (DB-REPOSITORY-PILOT-02-C2-B) (5266f36)
- **db**: route api token last-used update through repository (DB-REPOSITORY-PILOT-02-C2-A) (c7f2f81)
- **db**: route api token lookup through repository (DB-REPOSITORY-PILOT-02-C1) (0879a79)
- **db**: add api tokens repository for token routes (DB-REPOSITORY-PILOT-02-B) (5dd578c)
- **db**: route vec_dim setting through repository (DB-REPOSITORY-PILOT-01-B) (81e2bf7)
- add system_settings and custom_fonts repositories (DB-REPOSITORY-PILOT-01-A) (71aab0c)

### 📝 文档

- document ICP filing docker env (4a0511f)
- mark PG-PILOT-03 fully closed (150a253)
- mark PG-PILOT-02 fully closed (75cd60d)
- mark PG-PILOT-01 fully closed (1f4cffd)
- document postgres pilot validation blocker (5c43575)
- add postgres schema sql draft (PG-SCHEMA-02) (b176cac)
- add postgres schema migration plan (PG-SCHEMA-01) (ac6fe31)
- add repository pilot guide and migration rules (bed266b)

### 💄 样式

- **css**: 修复 Traffic Light 相关注释乱码 (ef71944)

### ✅ 测试

- assert ICP env source is documented in seed (b0a067a)
- cover ICP docker env source (a8474b5)
- update ICP site settings expectations (a77105b)
- cover rich text note version restore (4b9efd7)
- add postgres pilot for note tags repository (4bfaf3e)
- add postgres pilot for favorites repository (837b022)
- add postgres pilot for custom fonts repository (766356e)
- align postgres pilot test environment (a1d801d)
- add postgres pilot coverage for system settings repository (PG-PILOT-01) (8f16968)
- fix known isolation test failures (1edc05c)
- add repository-level atomicity rollback test for replaceLinksForSourceAsync (8b7ae9c)
- add serial test script for db isolation (TEST-ISOLATION-01-A) (841884b)
- **db**: add sqlite adapter behavior tests (DB-SQLITE-ASYNC-ADAPTER-PILOT-01B-TEST) (5d5b573)

### 🔧 其他

- tune sidebar layout constants (22e3ebf)
- define default ICP footer env values (09fc815)
- add postgres local development environment (PG-DOCKER-01) (776d35e)
- **journal**: 移除今日日记按钮 (af399c1)
- 从版本控制中移除 tsconfig.tsbuildinfo (78c7ddd)
- 将 tsconfig.tsbuildinfo 加入 .gitignore (f518a5f)
- **skills**: 添加中文提交规范 skill (9d2f2a1)
- exclude dist-electron-lite build artifacts from git (3c72186)

### 📌 杂项

- @ fix(security): SEC-XSS-01-C 分享页渲染清洗 + CSP 头 (9d07b6c)
- @ fix(security): SEC-XSS-01-B HTML 安全清洗最小实施 (19cb69b)


## v1.2.3 - 2026-06-26

### 🐛 修复

- ensure uploaded images render after local fallback (BUG-IMAGE-UPLOAD-PREVIEW-01) (b94deff)

### ♻️ 重构

- unify local attachment upload paths (ATTACHMENT-DIRECTORY-ORGANIZE-01-B) (bdf1431)

### 🔧 其他

- remove accidental noop file (f8b27a2)

### 📌 杂项

- noop (309d536)


## v1.2.2 - 2026-06-25

### ✨ 新增

- integrate image hosting into editor paste/drag/insert flows (IMAGE-HOSTING-INTEGRATE-01) (7865550)
- extraction status and logging for PDF/DOCX sync (DESKTOP-FOLDER-KB-SYNC-02-E.3) (eecb94e)
- extract PDF/DOCX text into contentText for search (DESKTOP-FOLDER-KB-SYNC-02-E.2) (35fb01c)
- third-party image hosting with S3-compatible storage (IMAGE-HOSTING-ENHANCE-01) (c5ed326)
- PDF/DOCX attachment sync UI and docs (DESKTOP-FOLDER-KB-SYNC-02-D) (67d0d85)
- support PDF/DOCX attachment upload in folder sync (DESKTOP-FOLDER-KB-SYNC-02-B) (d59f258)
- auto sync observability and safety (DESKTOP-FOLDER-KB-SYNC-01-E.2.1) (d46340d)
- folder sync file import with attachment support (DESKTOP-FOLDER-KB-SYNC-01-C.2) (19114c1)
- auto folder sync during app runtime (DESKTOP-FOLDER-KB-SYNC-01-E.2) (a5b1ab1)
- add folder sync interval config UI (DESKTOP-FOLDER-KB-SYNC-01-E.1) (0809ba5)
- enhance folder sync status display and logs (DESKTOP-FOLDER-KB-SYNC-01-D) (f702777)
- desktop folder sync upload for text files (DESKTOP-FOLDER-KB-SYNC-01-C.3) (ffe6661)
- add folder sync backend import endpoint (DESKTOP-FOLDER-KB-SYNC-01-C.2) (7f2822a)
- Nowen package import with ID remapping (NOWEN-PACKAGE-IMPORT-01) (7a6c2af)
- local folder scan, sha256 index, sync logs (DESKTOP-FOLDER-KB-SYNC-01-C.1) (edd218d)
- add notebook selection and config editing for folder sync (DESKTOP-FOLDER-KB-SYNC-01-B.1) (ba855fe)
- desktop folder selection and local sync config (DESKTOP-FOLDER-KB-SYNC-01-B) (f9f5a51)
- Markdown source/preview/split view modes (MARKDOWN-PREVIEW-MODE-01) (46a4fb7)
- Nowen package export for lossless migration (NOWEN-PACKAGE-EXPORT-01) (10effe8)
- show note format badge in list, sidebar and editor (NOTE-FORMAT-BADGE-01) (3f7a470)
- 原生 Markdown 笔记创建入口 + 回收站锁定 + 文档更新 (e339e17)
- **v1.2.2**: contentFormat 原生 Markdown 笔记 + 回收站锁定 + 文档扩充 (1207194)
- 增加笔记列表更新时间显示开关 (NOTE-LIST-TIME-VISIBILITY-01) (8b4b043)
- 附件按上传年月分目录存储 (ATTACHMENT-STORAGE-DATE-PATH-01) (2baa097)
- 移动端编辑器支持保存单张图片到相册 (NOTE-EDITOR-IMAGE-SAVE-01) (7c2a440)
- 安卓端导出图片保存到相册 (NOTE-IMAGE-EXPORT-02) (b8ab9af)
- 分享页 Lightbox 支持图片缩放 (SHARE-IMAGE-LIGHTBOX-01.4) (9a1ad5b)
- 分享页图片支持 Ctrl+滚轮缩放 (SHARE-IMAGE-LIGHTBOX-01) (8b2f154)
- Sidebar ?????????? PNG/JPG (NOTE-IMAGE-EXPORT-01.1 ??) (6d83bbe)
- ?????? PNG/JPG ?? (NOTE-IMAGE-EXPORT-01) (9bca066)
- ?????????? (TASK-FULLSCREEN-01) (39de523)
- ???????????? (TASK-CALENDAR-SUBSCRIBE-01-C) (891e4fd)
- ?????????? ICS Feed (TASK-CALENDAR-SUBSCRIBE-01-B) (b62538a)
- 说说模块增加日历记事视图 (SAY-CALENDAR-01) (40ce3e3)
- 待办模块移动端交互适配 (TASK-MOBILE-UX-01) (eab94bd)
- 沉浸式视频浏览模式 (DIARY-FEED-01) (5c51055)
- 说说草稿自动保存 (DIARY-DRAFT-01) (0d32e58)
- 说说时间线筛选增强 (DIARY-TIMELINE-FILTER-01) (4337fc3)
- 说说编辑器支持完整媒体编辑 (DIARY-EDITOR-MEDIA-01) (8d3ab2d)
- 说说视频 Range 请求支持 (DIARY-VIDEO-RANGE-01) (a13e2a8)
- 编辑器页面内全屏 + 分享页大纲清理 (0d4a649)
- show attachment storage mode in file manager (d382e59)
- add shared note outline (8dc5150)

### 🐛 修复

- pre-existing TypeScript errors across multiple components (7d1e9d8)
- add extracted/extractionError fields to importAttachment return type (4bd5b8a)
- remove remaining orphaned folderSync checkDedup code (dfdcb62)
- remove orphaned importAttachment code from api.ts merge (dc71eaa)
- merge duplicate folderSync API, add missing exports, fix imageUploadService (676705f)
- TypeScript errors for Docker build (Buffer, broadcastToUser, ImageHostingConfig) (e2e1b6b)
- check note read permission for attachment download (BUG-SHARED-ATTACHMENT-DOWNLOAD-01) (eee27ac)
- image hosting encryption key production validation (IMAGE-HOSTING-ENHANCE-01.2) (ee93827)
- image hosting security audit fixes (IMAGE-HOSTING-ENHANCE-01.1) (7dd2c2e)
- rename Image import to avoid DOM constructor conflict (1bb6d4f)
- add workspaceId/hash/uploadSource to folder sync attachment import (DESKTOP-FOLDER-KB-SYNC-02-C) (89fb580)
- folder sync attachment import, HTML format, security (DESKTOP-FOLDER-KB-SYNC-01-C.2.1) (0789358)
- folder sync scan bugs and security (DESKTOP-FOLDER-KB-SYNC-01-C.1) (6b9fac2)
- move rootNotebookId declaration outside try block (8093160)
- folder sync skipped status and sourcePathHash namespace (DESKTOP-FOLDER-KB-SYNC-01-C.3.1) (4cfdecd)
- import order, effective attachment map, workspace passthrough (NOWEN-PACKAGE-IMPORT-01.1) (f96a285)
- store sync notes as plain Markdown, add folder_sync_files table (DESKTOP-FOLDER-KB-SYNC-01-C.2.1) (edadd9a)
- add explicit Markdown preview styles without typography plugin (MARKDOWN-PREVIEW-MODE-01.2) (bbc2b07)
- render MarkdownPreview in editor area for source/preview/split modes (MARKDOWN-PREVIEW-MODE-01.1) (592a3dc)
- **i18n**: clean up garbled zh-CN calendarFeed and remove hardcoded bilingual dict (a1b8301)
- add toast import and fix buildHeaders in Nowen package export (d854cad)
- Nowen package attachment refs, schemaVersion, unknown format warning (NOWEN-PACKAGE-EXPORT-01.1) (b031a74)
- **auth**: clear remembered credentials after password change (3a1dbdf)
- use existing helpers in processMarkdownAttachments (EXPORT-CONTENT-FORMAT-01.2) (38e6e11)
- Markdown export scope, image processing and notebook export (EXPORT-CONTENT-FORMAT-01.1) (7bc32cb)
- export pipeline supports contentFormat (EXPORT-CONTENT-FORMAT-01) (dac4b28)
- **editor**: replace ? text with Sparkles icon for AI classify button (bf2d4e1)
- add contentFormat to GET notes list and search results (ce742a8)
- propagate contentFormat in noteToListItem and addNoteToList (NOTE-FORMAT-BADGE-01.1) (44cc79a)
- **sidebar**: add useTranslation to SidebarNoteItem for format badge (bb2333a)
- **mindmap**: remove read-only ref assignment for React 19 compat (3fade3d)
- **NoteList**: update CreateMenu onPick type to accept markdown (c78634c)
- **types**: add _noteId to NoteEditorUpdatePayload (a44bf5d)
- **tasks**: add explicit type annotations to fix Docker tsc build (b7d307f)
- **mindmap**: use non-passive wheel listener for zoom (4d4ea94)
- **notes**: allow user to clear document content, monitor only (6c8558c)
- **mindmap**: keep minimap fixed during pan and zoom (9c11174)
- **mindmap**: bind wheel zoom via onWheel prop after canvas mounts (b847188)
- **notes**: refine empty content guard to allow manual clear (ad62254)
- **notes**: add noteId snapshot to editor onUpdate callbacks (0a64965)
- **mindmap**: enable wheel zoom on canvas (061d907)
- **notes**: create favorite note from favorites view (73364a0)
- **notes**: prevent accidental empty content overwrite (d414eb2)
- **notebook**: allow revoking share links (566fbcf)
- **ai**: add missing toast import in AIWritingAssistant (72170be)
- **ai**: use parseAiTags for proper JSON array parsing in tag generation (bc98bbd)
- **sync**: broadcast note:deleted when deleting notebook + add diagnostic logs (b180a22)
- **todo**: remove blank gap beside task detail panel (2a75aaa)
- **ai**: sanitize reasoning content from generated outputs (507c365)
- **search**: prevent false positive note results (f0628f7)
- **sync**: handle note deletion events globally (e111ab7)
- **todo**: refine task workspace layout (6bdb14c)
- **sync**: 全局监听 note:deleted 触发列表刷新 (SYNC-DELETE-01-B) (298a135)
- **context-menu**: add export image formats to note list submenu (90a3f43)
- zh-CN 补齐 noteList.export 导出子菜单文案 (bb5cda6)
- 导出子菜单真正生效 — 替换 displayItems 中旧平铺结构 (BUG-CONTEXT-MENU-EXPORT-SUBMENU-01) (47e1770)
- 修复树形目录右键 PNG/JPG 导出无响应 (NOTE-IMAGE-EXPORT-01.2) (bc692fc)
- 防止孤儿清理误删待办图片附件 (TASK-ATTACHMENT-ORPHAN-CLEANUP-01) (b8f6ec5)
- 树形笔记目录联动更新时间显示开关 (NOTE-LIST-TIME-VISIBILITY-01.2) (8d5a8a4)
- 设置页联动笔记列表更新时间开关 (NOTE-LIST-TIME-VISIBILITY-01.1) (63d79d9)
- 附件路径校验拒绝反斜杠并支持两层月份递归扫描 (ATTACHMENT-STORAGE-DATE-PATH-01.1) (fd85706)
- 加强附件路径校验并跳过 .thumbs 扫描 (ATTACHMENT-STORAGE-DATE-PATH-01) (7b7f39a)
- 优化移动端图片预览工具栏布局 (EDITOR-IMAGE-PREVIEW-MOBILE-01) (44bfaf6)
- 安卓相册保存路径使用 Environment.DIRECTORY_PICTURES (13a07eb)
- 修复编辑器图片间距与换行兼容 (EDITOR-IMAGE-LAYOUT-01) (1c60ac3)
- 分享页图片缩放调试日志 (d86804b)
- 增强分享页图片 width 链路排查日志 (SHARE-IMAGE-LIGHTBOX-01.4) (db258f9)
- 添加分享页图片缩放排查日志 (SHARE-IMAGE-LIGHTBOX-01.4) (0f615f8)
- 修复分享页图片缩放源数据丢失问题 (SHARE-IMAGE-LIGHTBOX-01.3) (e61d484)
- 修复分享页 Markdown 图片缩放未生效 (SHARE-IMAGE-LIGHTBOX-01.2) (90b7325)
- 修复分享页图片缩放尺寸未生效 (SHARE-IMAGE-LIGHTBOX-01.1) (f735be1)
- 分享页图片按缩放尺寸显示并支持预览 (SHARE-IMAGE-LIGHTBOX-01) (c85aa9c)
- ???????????? (TASK-CALENDAR-FEED-UX-01) (b35453d)
- ???????????????? (AUTH-FIRST-CHANGE-LOOP-01) (c2a58e3)
- ????????????????? (TASK-QUICKADD-IMAGE-01) (249b73b)
- ????????? i18n hotfix (NOTE-IMAGE-EXPORT-01.1) (c8af5ff)
- 修复待办日历订阅多语言显示 (I18N-CALENDAR-FEED-01) (3425f60)
- ???????????????????? (BUG-TALK-FILTER-UI-01) (1076cdf)
- DiaryEditor 补回 cameraInputRef + DiaryCard forwardRef 修复 (dce654d)
- 补回 DiaryCenter 缺失的 calendarOpen state 声明 (181642b)
- 补回 EditorPane 缺失的 buildAiContext/extractFinalAnswer 导入 (6de024a)
- complete inline note context menu actions (d579df8)
- expose latest context menu target (91f9c20)
- 移动端抽屉导航后自动关闭 (MOBILE-DRAWER-CLOSE-01) (1a87d8c)
- 待办移动端遗漏交互补丁 (TASK-MOBILE-UX-01.1) (d3201e8)
- 已初始化实例隐藏默认账号提示 (AUTH-LOGIN-DEFAULT-CREDS-01) (0fd885d)
- 草稿清空时释放已上传媒体 + 移除 BOM (DIARY-DRAFT-01.1) (32db2c3)
- 筛选空状态与心情筛选交互优化 (DIARY-TIMELINE-FILTER-01.1) (8b51ed3)
- 编辑器多文件选择时混发漏检 (DIARY-EDITOR-MEDIA-01.2) (3701679)
- DiaryEditor addFiles 编译错误 + 逻辑修正 (DIARY-EDITOR-MEDIA-01.1) (2fb843d)
- 移除 DiaryEditor 中重复的 input refs 声明 (3a52540)
- VideoBlock 错误占位 React 化 + i18n (DIARY-VIDEO-RANGE-01.1) (ebd88f7)
- 文件存储国际化与Diary路由修复 (5abe992)
- normalize English locale encoding (afec86b)
- ignore stale notebook note fetches (92a3ce9)
- **tasks**: V1.2.1 待办功能修正——截止时间拆分、自定义提醒、子任务拖拽排序、按截止时间排序 (8d0e6d8)

### ♻️ 重构

- 折叠笔记右键菜单导出项 (CONTEXT-MENU-COMPACT-01) (395951f)

### 📝 文档

- finalize PDF/DOCX folder sync documentation (DESKTOP-FOLDER-KB-SYNC-02-Z) (855d7bb)
- desktop folder sync documentation and MVP sign-off (DESKTOP-FOLDER-KB-SYNC-01-Z) (582357a)

### 💄 样式

- 表格单元格默认水平垂直居中 (EDITOR-TABLE-CELL-CENTER-01) (d8b9cdb)

### 🔧 其他

- clean up MarkdownEditor header comment encoding (MARKDOWN-EDITOR-CLEANUP-01) (b9987d6)
- 移除最近提交中的 UTF-8 BOM (ca97d74)
- 清理分享页图片调试日志 (6f57cab)
- remove temporary mobile layer stack workflow (9848048)
- trigger mobile layer stack auto fix (05cb80a)
- add temporary workflow for mobile layer stack fix (955f2f4)
- remove temporary auto fix workflow (afbc17b)
- trigger notebook tree note menu auto fix (be3fabc)
- add temporary auto fix workflow for notebook tree note menu (410f1fd)
- remove duplicate comment in DiaryCenter (fe0c809)

### 📌 杂项

- 优化：接入长笔记AI上下文预算与分块处理 (AI-LONG-NOTE-CONTEXT-01) (96d7e10)
- 优化：新增长笔记AI上下文构建工具 (ebad1d4)
- 新增：AI推理输出清洗工具 (176e11b)
- 修复：清洗AI推理输出并忽略reasoning流 (43e6a14)

### ✨ 新增

- Android 导出图片保存到相册，导出的 PNG/JPG 文件会自动写入系统相册方便查看和分享 (NOTE-IMAGE-EXPORT-02)
- 移动端编辑器支持单张图片保存到相册，长按或点击图片即可一键保存 (NOTE-EDITOR-IMAGE-SAVE-01)
- 笔记列表支持隐藏更新时间显示，在设置中可切换是否展示每条笔记的最后更新时间 (NOTE-LIST-TIME-VISIBILITY-01)
- 表格单元格默认水平和垂直居中对齐，新插入的单元格内容自动居中显示 (EDITOR-TABLE-CELL-CENTER-01)
- 附件按上传年月自动分目录存储，新增的附件会存入 `年/月` 子目录，便于管理和备份 (ATTACHMENT-STORAGE-DATE-PATH-01)

### 🐛 修复

- 修复孤儿清理机制可能误删待办任务中图片附件的问题，清理前增加引用检查 (TASK-ATTACHMENT-ORPHAN-CLEANUP-01)
- 修复删除笔记或清空回收站后其他设备不同步的问题，跨端删除操作现在能实时同步 (SYNC-DELETE-01-B)
- 修复树形目录右键菜单点击 PNG/JPG 导出时无响应的问题 (NOTE-IMAGE-EXPORT-01.2)
- 修复搜索结果偶尔误报无关内容的问题，提高搜索结果准确性 (f0628f7)
- 过滤 AI 回复中的思考过程内容，避免用户看到模型内部推理细节 (507c365)
- 笔记本分享链接支持撤销，分享者可随时取消已生成的分享链接 (566fbcf)
- 修复思维导图使用滚轮缩放时缩放方向和灵敏度异常的问题 (4d4ea94)
- 回收站中的笔记自动锁定，禁止编辑、收藏和加锁操作，防止误操作恢复被删内容
- 修复偶发的笔记内容被意外清空问题，增强编辑器内容保护机制 (d414eb2)

## v1.2.1 - 2026-06-16

### ✨ 新增

- **tasks**: 增加待办任务详情描述（TASK-DESC-01） 背景/目标：当前待办任务仅保留标题，缺少更完整的上下文与验收说明。本次变更为任务引入 description 字段，用于记录步骤、备注、验收标准等详细信息，不扩展富文本与协作功能。 主要变更：数据库：在 backend/src/db/migrations.ts 新增 v28 迁移 tasks-add-description，通过 PRAGMA table_info(tasks) 检查并执行 ALTER TABLE tasks ADD COLUMN description TEXT NOT NULL DEFAULT ''，保持幂等，旧任务自动兼容。后端接口：在任务创建流程写入 description；在任务更新流程支持 description 更新（含清空）；重复任务生成时复制 description；模板相关路径同步透传 description。类型：为 Task 新增 description: string，为 TaskTemplateItem 新增 description?: string，前端统一使用 task.description ?? '' 兼容历史数据。详情面板：在 TaskDetailPanel 新增纯文本 textarea，支持多行输入，onBlur 保存并保留本地输入；新增成功/失败提示文案。列表与看板：FlatTaskRow、TaskTreeRow、TaskBoardView 增加轻量摘要，避免打断紧凑布局。搜索：将任务检索范围扩展到 title 与 description，不改变现有搜索入口。国际化：补充 tasks.fields.description、tasks.fields.descriptionPlaceholder、tasks.toast.descriptionUpdated、tasks.toast.descriptionUpdateFailed，并对齐 en/zh-CN。测试：新增 task-description、taskSearch、TaskTemplateEditor 相关测试，补齐测试 mock 中 description 字段。 验证：frontend tsc/vite build 通过；frontend test 通过；backend build:tsc 通过；任务描述相关后端与前端测试通过。 (e06dfdf)
- Phase 7.1.1 空状态 + 操作反馈 + 重试按钮 (9667ab2)
- Phase 6.4 轻量自动化提醒 — 依赖完成通知、逾期每日提醒 (267958a)
- Phase 6.2 轻量提醒操作 — 稍后提醒、关闭/开启提醒、跳转任务 (450c289)
- Phase 6.1 提醒中心增强 V1 (26194a5)
- Phase 5 - 甘特图 / 时间轴 V1 (cde9c29)

### 🐛 修复

- Phase 7.1.0 P0 清理 — 通知文案 i18n + BOM 清理 (69e7d6e)
- Phase 6.4.1 自动化提醒稳定化 — 依赖全部完成才通知、dueAt 用 JS 时间比较 (aae9ae8)
- Phase 6.2.3 补齐 TaskReminder.snoozedUntil 类型 (a668eed)
- Phase 6.2.2 snoozedUntil 后端接线修复 — PUT 写入、SELECT 扫描、测试补齐 (33b1feb)
- Phase 6.2.1 提醒操作稳定化 — snoozedUntil 字段、可靠 snooze、button 嵌套修复 (cae5e8d)
- Phase 6.1.1 提醒中心 Electron 环境识别与 offset 国际化 (5b0adde)
- Phase 5.0.1 - 甘特图/时间轴稳定化 (0a998af)
- Phase 4.7.1 - 任务模板稳定化 (84bf28f)

### 🔧 其他

- **repo**: 同步本次会话中的其他本地改动 背景/目标：在完成 TASK-DESC-01 后，一并提交剩余本地工作区改动，便于代码库保持整洁。 主要变更：新增/更新 shareOutline、ShareOutline、ReminderCenter、DiaryCenter、SharedNoteView、taskTitleTokens 及其测试产物；补充 docs/screenshots 与 .playwright-mcp 相关记录文件。 验证：在提交前已确认 TASK-DESC-01 单独完成提交，本次提交仅包含与任务详情描述无关的其余本地改动。 (7dd4437)

### 📌 杂项

- Phase 6.0.2: add TaskReminder.updatedAt to frontend type (3c4829e)
- Phase 6.0.1: reminder type + test fixes (e2d5877)
- Phase 6.0: reminder infrastructure stabilization (d98ccf6)
- Phase 5.5.1: cascade delete cleanup for task_dependencies on child task removal (455ac38)
- Phase 5.5: task center regression + tech debt cleanup (a90a1e3)
- Phase 5.4: dependency-driven lightweight reschedule suggestions (8ba21f0)
- Phase 5.3: dependency status indicators - blocked task visual hints (e41979c)
- Phase 5.2.1：任务依赖线稳定化 hotfix — 修复 6 个 P0/P1 (f5427e7)
- Phase 5.2：任务依赖线 V1 — 数据模型 + 循环检测 + 甘特图依赖线 + 详情面板管理依赖 (c8e1488)
- Phase 5.1：甘特图体验增强 — resize 调整日期范围 + 跨区间显示 + 一键排期 + today 指示器修复 + BOM/编码清理 (dd9f8ce)


## v1.1.20 - 2026-06-12

### ✨ 新增

- Phase 4.7 - 任务模板 V1 (84c92c4)
- Phase 4.6 - AI 拆任务 (f4bee48)
- Phase 4.5 - 重复任务 (f161c89)
- Phase 4.4 - 日历拖拽改截止日期 (7bd2ea5)
- Phase 4.3 — 任务日历视图 (a153357)
- Phase 4.2 — 项目编辑弹窗、移动端项目选择、看板拖拽、卡片增强 (bd9defe)
- 补充 v22 迁移 — task_projects 表 + tasks 新增 projectId/status 字段（Phase 4 数据层遗漏修复） (c6cb7a3)
- Phase 4 - task projects, kanban board view, status field, project sidebar (7d740bb)
- frontend reminder system (b6fe42b)
- **编辑器**: 选区气泡菜单增强——复制、全选、手机号拨号、URL 识别、横向滚动 (84b6f76)
- **textActions**: 新增文本动作识别工具库，支持手机号拨号和 URL 检测 (4b3fbdb)
- Phase 4 — 搜索、快捷键、批量操作、拖拽排序 (c2db189)
- 任务中心 Phase 3 — 提醒系统 (1ffc575)
- 任务中心 Phase 2 — 截止时间精确到分钟 + 倒计时 (813ba68)
- 任务中心 Phase 1.5 — 子任务快捷新增、删除确认、详情子任务列表、父任务路径 (cd16252)
- 任务中心 Phase 1 — 顶部概览、树形任务、进度条、详情进度 (45b44d7)

### 🐛 修复

- 修复 FlatTaskRow.tsx 编码损坏导致构建失败 (da530a0)
- 修复 6 个 TypeScript 编译错误 (860f44f)
- Phase 4.6.1 - AI 拆任务稳定化 (fa6a362)
- **AI思维导图**: 修复 AI 返回思考过程导致 Mermaid 解析失败的问题 (5acd442)
- Phase 4.5.2 - 重复任务收口 (4b0c008)
- Phase 4.5.1 - 重复任务 hotfix (e1c6fd5)
- 任务中心多语言修复 (f125cee)
- Phase 4.4.3 - 拖拽成功后 loadTasks 刷新筛选视图 (aec282f)
- Phase 4.4.2 - 拖拽后筛选刷新、BOM清理、注释修正 (4e59ac9)
- Phase 4.4.1 - 日历拖拽稳定化 (515904a)
- Phase 4.4 hotfix - 修复嵌套函数和缺失 prop (bcddcc8)
- Phase 4.3.1 - 日历逾期统一、英文日期格式、空日期状态 (c442575)
- Phase 4.2.2 — MobileProjectPicker 打不开、移动端新建项目旧 state、看板 dueAt-only 逾期 (1b3eb19)
- Phase 4.2.1 — 移动端项目入口接入、工作区切换刷新、看板逾期判断、拖拽保护 (96ea808)
- Phase 4.1.1 — status 枚举校验、批量完成同步、批量删除 descendants、工作区切换刷新项目 (5cd94cf)
- Phase 4.1 — 项目绑定/权限/状态同步/计数刷新全面修复 (6c4ac43)
- overdue filter and stats use datetime precision for dueAt (7ab46b0)
- Phase 3.5 stability audit - reminder auth, overdue precision, notification status (3e006d8)
- **EditorPane**: 修复移动端按钮 title 乱码和乱序问题 (44b6746)
- tasks INSERT VALUES 缺少 dueAt 占位符（9 values for 10 columns） (2f3f37d)
- migration v20 dueAt 列探测失败 — 改用 PRAGMA table_info 安全检测 (0cf18d3)
- migrations.ts 模板字符串丢失反引号导致后端构建失败 (4ddb9e2)
- 任务中心 Phase 1 全面修复 — 删除子任务、orphan 绑定、循环依赖、逾期判断、后端防护 (d7a916b)
- 任务中心 Phase 1 审查修复 — 删除子任务残留、状态同步、循环防护 (f74a9f0)

### ✅ 测试

- Phase 3.5 - taskProgress, DateBadge, reminder scanner unit tests (8b4e0b9)


## v1.1.19 - 2026-06-11

### ✨ 新增

- **前端**: 思维导图标记和主题名称支持多语言 i18n (8f46744)
- add notebook-first collaboration with hidden workspace UX (e6875a1)
- **mindmap**: 侧边栏搜索框旁增加收藏筛选按钮 (df89085)
- **mindmap**: 新建文件夹按钮移到列表顶部 (ccc6425)
- **mindmap**: 文件夹右键菜单 - 重命名/删除 (37313a7)
- **backend**: 新增导图移动到文件夹的 PATCH /:id/move 路由 (770b062)
- **mindmap**: 支持拖拽导图到文件夹 (4213873)
- **mindmap**: 导图模板功能 - 新建导图时可选择预设模板 (09f7f17)
- **mindmap**: 文件夹树前端 UI (1adf85a)
- **mindmap**: 文件夹树后端 + 数据模型 (124562f)
- **mindmap**: 节点聚焦模式 (9c0ed1a)
- **mindmap**: 拖拽节点调整结构 (044cb67)
- **mindmap**: 收藏导图功能 (f1868bd)
- **mindmap**: 节点复制/剪切/粘贴 (a272d4f)
- **mindmap**: Ctrl+滚轮鼠标位置缩放 + 节点搜索 + 列表搜索 (7ffe9eb)
- **mindmap**: 支持 Ctrl+Click 多选节点 (0f0f462)
- **mindmap**: 思维导图模块 5 阶段增强 (e8f3c66)
- **mindmap**: 新增全屏编辑模式 (db3ae8b)
- **mindmap**: 新增添加同级节点 + 快捷键 + 选中节点置顶渲染 (5348b85)
- **mindmap**: 新增 mindmapTransform.ts 独立解析器 (8255b65)
- **editor**: MermaidView 工具栏增强 + MindMapEditor 事件监听 + 编辑器 appendMarkdown (03e7782)
- **ai**: AIChatPanel 支持笔记本级 RAG 作用域 (9a3a4a3)
- **ai**: EditorPane 新增 AI 总结、AI Mermaid、保存为思维导图 (8effbf2)
- **ai**: 前端 API 扩展 + i18n + NoteEditorHandle 类型增强 (54a7b26)
- **ai**: 后端 AI 路由改造 + 笔记本级 AI 端点 (f81d0b8)
- **ai**: 新增 AI Client 适配层，统一 stream/non-stream 调用 (c1e182d)

### 🐛 修复

- **前端**: NoteList 补回 confirm 导入，修复 tsc -b 构建错误 (182c698)
- **前端**: 修复6个TypeScript编译错误 — import缺失、path字段缺失、函数未导出 (76721f1)
- **前端**: 补回缺失的 diagnoseConnection 导出函数，修复 vite build 失败 (bb765a6)
- **Electron**: setupWindow 和 waitForRemoteReady 支持反代路径前缀 (142c990)
- **前端+后端**: 服务器地址支持反代路径、修复Windows频闪、新增连接诊断 (4442716)
- **前端**: 浮动操作条按钮添加细微边框增强轮廓感 (7cb9e70)
- **前端**: 思维导图标记菜单改用带颜色SVG图标，与节点显示一致 (1014ca0)
- **前端**: 浮动操作条按钮增强可见性 — 加深背景色、加粗文字、加大点击区域 (98fbff7)
- **backend**: 修复 mindmaps 相关路由 TypeScript 编译错误 (174f668)
- **mobile**: 修复移动端回收站一键清空按钮无响应 (1f2fb74)
- **mindmap**: 文件夹数量跟随收藏/搜索筛选动态更新 (380d594)
- **i18n**: 修复文件夹右键菜单中文翻译乱码 (e38650f)
- **i18n**: 修复导图模板中文翻译乱码 (42b1d73)
- **backend**: requireWorkspaceFeature 中间件正确放行 personal 空间请求 (a0c4947)
- **backend**: 修复 personal workspaceId 传入时文件夹和导图 API 返回 403 的问题 (164b8d8)
- **mindmap**: Ctrl+滚轮缩放改为原生事件，阻止浏览器页面缩放 (fe67b0f)
- **mindmap**: 修复 FloatingToolbar 定位偏移 (9f4ccc3)
- **mindmap**: 修复数据风险 + UI 扁平化 + 代码拆分 (a789add)
- **mindmap**: 适应视图图标改为 Scan，与全屏 Maximize2 区分 (d988ec1)
- **i18n**: 补全思维导图多语言文案 (ffc33cd)
- **ai**: 标题生成字数限制从10改为20，避免AI输出被截断 (8dfcb05)
- **mindmap**: 保存为思维导图后可靠跳转 + 使用独立解析器 (caff2d6)
- **ai**: 修复 RAG 向量召回未传 notebookIds + /ask 复用 ai-client (9061916)
- **build**: 修复 vite 构建循环 chunk 错误 (9d81de3)

### ♻️ 重构

- **前端**: 思维导图样式收尾 — indigo→blue统一、transition补齐、菜单背景token化、模板弹窗圆角与阴影优化 (e0db228)
- **前端**: 思维导图悬浮状态与创建按钮样式统一收敛 (ef81bea)
- **前端**: 思维导图菜单与激活态样式继续收敛 (dec1717)
- **前端**: 思维导图模块 macOS 风格样式重构 (87a48b3)

### 📝 文档

- 添加完整官网教程体系（47篇教程 + 索引 + 规划） (210f537)


## v1.1.18 - 2026-06-09

### ✨ 新增

- 更新Android组件和Tiptap编辑器功能 (c489050)
- 增强Tiptap编辑器功能并优化用户体验 (ce05f9e)
- 添加鸿蒙ArkWeb原生应用项目 (f63e84f)
- 添加鸿蒙ArkWeb WebView原生适配支持 (f6d4923)

### 🐛 修复

- 移动端Sidebar约束宽度防溢出，移除选择时自动关闭侧边栏的逻辑 (03bb588)
- 移除NavRail点击导航项后自动关闭移动端侧边栏的逻辑 (a429f1a)
- 移动端侧边栏遮罩区分点击/滑动，禁用手势关闭侧边栏，添加overflow-hidden防溢出 (948e447)
- 优化Android WebView选择菜单处理，使用委托模式替代直接返回null (fa20e06)


## v1.1.17 - 2026-06-08

### ♻️ 重构

- 大规模代码精简和架构优化 (60f051b)


## v1.1.16 - 2026-06-05

### ✨ 新增

- 全面增强搜索功能和用户体验 (524cf8c)
- 增强搜索体验和侧边栏布局管理 (14b61c2)
- 增强附件对象存储功能和搜索高亮显示 (7ce7d53)

### 🐛 修复

- 修复 TypeScript 编译错误 - Buffer 类型兼容性 (ff2f4b5)
- 全面优化版本恢复功能和编辑器状态管理 (85783d1)
- 优化侧边栏布局计算和滚动性能 (5e49465)

### 📌 杂项

- 实现对象存储支持和同步中心功能 (d576ec1)


## v1.1.15 - 2026-06-04

### 📌 杂项

- 优化同步引擎和网络状态检测 (a2e6fbd)
- 修复macOS Electron侧边栏拖拽区域CSS (07545f2)


## v1.1.14 - 2026-06-03

### ✨ 新增

- 侧边栏重构、右键菜单优化及多语言支持增强 (3dadbcc)
- 笔记内联到笔记本树，移除独立笔记列表列 (406d599)

### 🐛 修复

- 修复标题聚焦边框问题，使用 node 写入避免 PowerShell UTF-8 BOM 损坏 (94e2061)
- 移除标题输入框聚焦时的粗边框 (b2154b5)
- 修复 JSX style 模板字符串中缺失的反引号 (1da66ed)
- 从原始文件重新应用笔记内联功能，修复 UTF-8 编码损坏 (9a8ed99)
- 修复递归 NotebookItem 调用中 /> 位置错误和缺失 notes prop (bedd28f)
- 恢复被 Set-Content UTF8 编码破坏的 emoji 字符 (a6b9296)
- 修复字号/颜色弹窗点击外部关闭逻辑，优化自定义颜色交互 (cc4bd64)

### 🔧 其他

- 提交剩余改动 (157e2e8)

### 📌 杂项

- 优化用户体验和编辑器功能 (f671a3d)


## v1.1.13 - 2026-06-02

### 🐛 修复

- restrict color-mix focus fallback to form elements only (f9e58ec)
- Backspace at line start now correctly decreases indent (Office-like behavior) (aadc88a)
- add CSS fallbacks for older Android WebViews (Xiaomi 8 black screen) (aa9a2fd)


## v1.1.12 - 2026-06-01

### 🐛 修复

- resolve remaining TS null-check and changeIndent type errors (98fc8fd)
- resolve all 13 TS7006/7022/7023/7031 implicit any errors (732420d)
- clip row resize guide line to table bounds (a5a6c5c)
- clip row resize guide line to editor bounds (45f9342)
- table row height drag now follows mouse in real-time via transaction (1edae9c)
- improve table row height resize UX - wider hit area and real-time visual feedback (539c56c)
- Backspace at line start reduces indent level (437fb38)
- table bubble merge button visibility + mini toolbar (ea6a088)

### 📌 杂项

- Update README.md (4b9a660)


## v1.1.11 - 2026-05-29

### ✨ 新增

- **editor**: 表格交互优化 - 网格选择器与行高丝滑拖拽 (f92168e)


## v1.1.10 - 2026-05-29

### ✨ 新增

- **prefs**: 新增阅读密度偏好（宽松/紧凑） (3d94607)
- **mobile**: 搜索按钮上提到笔记标题栏 (e0f047c)
- **editor**: 表格新增行高可拖拽功能 (c5c2461)
- 新增客户端下载面板 + Gitee Release 镜像同步 (93a6117)

### 🐛 修复

- **download**: 修复 DownloadPanel icon 类型 TS2322 编译错误 (ced169b)
- **editor**: 收紧图片上下间距 (29ccead)
- **upk**: use host network for ugreen package (68065b9)

### 🔧 其他

- **upk**: update zh-CN display name (bcd55ee)


## v1.1.9 - 2026-05-28

### 🐛 修复

- **desktop**: prevent local mode reload loop (490f5a3)


## v1.1.8 - 2026-05-28

### 🐛 修复

- 调整访问控制默认开关 (b49534c)


## v1.1.7 - 2026-05-28

### ✨ 新增

- 优化桌面端云端本地模式与访问控制 (783cf6a)
- **release**: 选项 10 改为'补 upk 到现有 Release'模式（不打新 tag、不升版本） (7e4c626)

### 🐛 修复

- 修复桌面端切回本地离线模式时，本地后端被误判为远端导致黑屏/反复闪屏的问题。
- 修复后端实时删除广播编译错误 (22fcc3c)
- improve multi-device note sync (0beb31e)
- **upk**: 补回被上一个 commit 误删的 const found 行 (0e81338)
- **upk**: cp/rm 之前按 resolve(src) 去重，避免重复处理同一文件 (9e95e54)
- **upk**: 递归扫描 .upk 产物，覆盖 ugcli 实际输出路径 build_dir/pkgs/upk/ (49467ff)
- **upk**: 补 upk 模式支持版本复用 + 修 RepoTag 与 compose 不一致 + ugcli 权限自愈 (00de4d9)

### 📝 文档

- **readme**: 添加在线体验入口（note.nowen.cn） (b626b3e)

### 🔧 其他

- 完善发布流程与编辑器设置 (0ae451d)
- update release workflow and editor UI (53c2e4d)

> 🚨 **紧急安全修复**：1.1.6 用户请尽快升级。该版本修复"登录云端账号"迁移功能在
> 同一台后端上误操作导致的**附件物理文件丢失**问题。

### 🐛 修复

- **【数据保护】回收站清空 / 永久删除笔记不再误删被多笔记共享的附件物理文件**
  - 受影响场景：1.1.6 在同一台服务器上点击"登录云端账号"产生双份笔记本后，
    手动删除其中一份并清空回收站，会触发被另一份笔记引用的图片被 unlink。
  - 修复后：批量删除附件文件前会做引用计数检查，仍有活引用的物理文件不会被删，
    与单条 `DELETE /api/attachments/:id` 的行为对齐。
- **【迁移防呆】"登录云端账号"对话框现在会拒绝迁移到同一台服务器**
  - 后端 `/api/version` 返回新增 `serverInstanceId` 字段（首次启动 lazy 写入
    `system_settings`，跨重启稳定）。
  - 前端 MigrationModal 在登录拿到云端 token 后立即比对两端 `serverInstanceId`，
    相同则直接拦截、提示"无需迁移，请退出登录后用新账号登录即可"。
  - 同账号场景（不同实例但本地与云端用户名一致）会弹二次确认，避免误操作。
- **【迁移一致性】附件 hash 去重命中时不再复用旧附件 id**
  - 编辑器上传、内联 base64 抽取、公众号/URL 导入图片在 hash 命中时，会新建一条
    绑定当前笔记的 `attachments` 元数据行，同时复用同一份磁盘物理文件。
  - 迁移引擎层新增 `serverInstanceId` 预检查；即使绕过弹窗直接调用迁移函数，
    也会在写入云端前阻断"本地端 == 云端"的同源迁移。
- **【附件健康检查】新增只读健康报告，帮助定位裂图 / 404**
  - 管理员可在「设置 → 数据管理 → 系统 → 数据库」执行附件健康检查。
  - 报告会列出 `attachments` 行存在但物理文件缺失、正文引用不存在附件 ID、
    以及多行共享同一物理文件的情况。
  - 孤儿清理逻辑同步补强：多条附件行共享同一个 `path` 时，只有最后一个引用消失
    才会删除物理文件，避免清理工具自身误删活文件。
- **【附件修复向导】健康检查结果现在可直接执行基础修复**
  - 对“DB 行存在但物理文件缺失”的附件，管理员可上传替代文件写回原 `path`；
    若多条附件记录共享同一物理文件，会一起恢复。
  - 对“正文引用不存在附件 ID”的悬空引用，管理员可批量从笔记正文中移除坏 URL，
    避免前端继续请求 404。
  - 修复类操作均要求管理员 sudo 二次验证；修复后会自动重新生成健康报告。
- **【多端同步】修复同账号 PC/Web 与手机端当前笔记不同步的问题**
  - 实时更新不再按 `userId` 过滤同账号其它设备，只按 `connectionId` 排除当前连接回声。
  - PC/Web 保存后会向同账号其它连接广播轻量列表更新，手机端停留在列表或当前笔记时都能立即看到变更。
  - 当前笔记无本地未保存修改时会自动拉取并应用远端新版本；本地也有修改时进入冲突横幅。
  - 正文保存遇到 `409 VERSION_CONFLICT` 不再盲目重放旧内容覆盖远端，而是保留本地草稿，提示用户选择“重新加载”或“覆盖远端”。
  - 移动端前台恢复、联网恢复、WebSocket 重连时会主动补查当前笔记版本，补偿后台期间漏掉的实时消息。

### ⚠️ 影响范围与建议

- 仅 1.1.6 用户受影响。1.1.5 及更早版本没有"登录云端账号"功能，无此风险。
- **如果你已经丢失图片**：先检查 NAS 快照 / 备份；该场景下数据库行可能仍在，
  但物理文件已被 unlink，应用层无法凭空恢复原图。升级后可先运行"附件健康检查"，
  再对缺失项上传从备份或其它来源找回的替代文件；找不回的悬空引用可在修复向导中移除。



## v1.1.6 - 2026-05-26

### ✨ 新增

- **release**: 将绿联 .upk 从一键全量(选项5)中移除，独立到选项10 (78bbdf6)
- **notes**: 支持客户端生成的 UUID 作为笔记 ID（离线创建） (c8d8961)
- **login**: 登录页支持桌面端跳过登录直接用本地 (21c9183)
- **migration**: 本地→云端账号一键迁移（D-2/D-3 + 回滚） (f61a6a9)
- **local-mode**: 本地模式离线读 + 同步引擎 + localStore (660489a)
- **desktop**: Electron 桌面端框架 + 内嵌后端启动 (762e6b0)
- **attachment-preview**: 视频/音频按扩展名兜底 + 抽屉打开时隐藏链接气泡 (33d6c61)
- **editor-mobile**: 移动端顶栏改 iOS 风双行结构 + 桌面面包屑末段截断修复 (235db1f)
- **frontend**: add video embed extension and rich-text video URL support (b8e3493)
- **editor**: auto-convert '- [ ] ' / '- [x] ' to task list (5c9a916)
- **login**: add demo mode banner with one-click credential fill (0a0c271)
- **auth**: 新增体验账号(isDemo) 机制 (8e0ab8a)
- **url-import**: 公众号文章一键导入笔记 (d6c7c17)

### 🐛 修复

- **release**: multi 模式 upk 打包前 buildx --load 各架构镜像 (7cceed0)
- **editor**: TiptapEditor 桌面端样式/行为微调 (7b72d7d)
- **mac-build**: 单架构构建 + .node 魔数 arch 校验，修复 Intel Mac ERR_DLOPEN_FAILED (54a9c90)
- **release**: defer UPK_IMAGE_REF assembly until VERSION is finalized (80390c9)
- **upk**: 改进多架构镜像查找逻辑，支持 DOCKERHUB_REPO 环境变量 (cc57a7f)
- **VideoExtension**: 修正 NodeView props 类型为 ReactNodeViewProps，修复 tsc 报错 (1083377)
- 绿联nas 构建包 (eb15be2)
- **clipper**: split footer build for markdown branch to preserve source link (45402e8)
- **update-notifier**: move useCallback before early return to fix hook order (63f2624)

### 📝 文档

- **readme**: 补 macOS 首次打开 ERR_DLOPEN_FAILED 的 xattr 解隔离指引 (bf108cd)
- **readme**: sync features and changelog with Unreleased (e301e93)

### 📦 构建

- **upk**: 新增绿联 NAS 应用包(.upk) 打包流程 (967d00d)

### 🔧 其他

- **clipper**: release v0.1.3 (5d70c08)


## v1.1.5 - 2026-05-21

### ✨ 新增

- **attachments**: 附件预览抽屉 + 本笔记附件目录面板 (df2e06f)
- **editor**: 搜索替换面板 / docx 自研解析与导入 / 字号弹层优化等 (3a37905)
- **about**: 新增'作者感言'板块及阅读弹窗 (82e872d)

### 📝 文档

- **readme**: add Author's Note link in header (6e5d863)


## v1.1.4 - 2026-05-20

_本版本无可展示的 commit 变更（可能全部是合并 / 工作流修改）_


## v1.1.3 - 2026-05-20

### ✨ 新增

- **trash**: 笔记本删除改为软删，回收站恢复自动还原祖先笔记本链 (aeba393)


## v1.1.2 - 2026-05-19

### ✨ 新增

- **editor**: 弱网防丢字 + 字号颜色 + Mermaid 放大预览 + 列表切换优化 (0ce7da6)

### 🐛 修复

- **import**: /export/import 返回 version=1，避免有道云附件回填触发 VERSION_REQUIRED (331bea7)
- bug (a701dd2)
- **release**: 体检加 lockfile 时间戳兜底，新增依赖自动 npm install (9cd7847)
- **release**: 白名单补 @tiptap/extension-text-style 防 TS2307 (a17aacb)
- 放大图片 (935a5e4)


## v1.1.1 - 2026-05-18

### ✨ 新增

- **mobile**: 移动端编辑器体验大改造 + 修复输入回退/Failed to fetch/点笔记没反应 (10b3e59)
- **backup**: P0~P1 backup/export/import improvements (0764826)

### 🐛 修复

- **ai**: scope knowledge-base notebook by workspace on import (9fd5138)


## v1.1.0 - 2026-05-15

### ✨ 新增

- enhance FileManager, SharedNoteView, clipboard & image host formats (ae28579)

### 🐛 修复

- **backend**: Buffer→Uint8Array<ArrayBuffer> 拷贝包装，彻底兼容 TS 5.7 类型 (ac1cd51)
- **backend**: 改用 Hono c.body() 替代 new Response()，彻底绕开 BodyInit 类型摩擦 (25ace00)
- **backend**: TS 5.7+ 下用 Blob 包装 Response body 修 BodyInit 不兼容 (51ca0c2)
- **backend**: 修复 attachments 缩略图 Response 在新版 TS 下的 BodyInit 类型错 (d5daecb)
- **mobile**: 优化移动端导航与任务中心布局 (592b18e)
- **share**: 路由正则支持 base64url 字符集；评论/分享/文件管理等多项改动 (6760199)
- **share**: 分享页图片在 IP+自定义端口部署上 https 误判导致全部 ERR (6139c1a)
- **release**: 发布时同步 bump backend/package.json 的 version (d73b747)

### 📝 文档

- 更新 README 用桌面端/移动端/AI 设置展示截图 (9865c92)


## Unreleased

### ✨ 新增

- **share**: 笔记分享支持未登录访客评论 + 新增「可编辑（需登录）」权限档
  - 权限选项扩到 4 档：`仅查看 / 可评论 / 可编辑 / 可编辑（需登录）`
    - `可评论`：未登录访客填昵称即可留言；评论对所有访客可见（留言板模式）
    - `可编辑`：原匿名编辑能力（沿用，访客填昵称即可）
    - `可编辑（需登录）`（新档 `edit_auth`）：必须登录账号才能写入；未登录用户点击「开始编辑」会被引导跳到 `/login?redirect=/share/<token>`，登录成功后自动回到分享页
  - 评论数据修正：v12 之前匿名评论的 `userId` 被强行写成笔记主 id（绕过 `NOT NULL` 约束），现 schema 迁移 `v13` 把 `share_comments.userId` 改 nullable + 新增 `guestName / guestIpHash` 列，访客昵称真正持久化、审计字段不再失真
  - 反垃圾基础措施：评论长度 ≤1000、同 IP 每分钟 ≤30 条、honeypot 字段
  - 用户注销改为 `ON DELETE SET NULL`：留言历史不再随账号销毁而蒸发，前端用 `displayName` 兜底展示
  - 安全：登录回跳的 `?redirect=` 仅接受相对路径，杜绝开放重定向



### ✨ 新增

- **files**: 文件管理新增「我的上传」分类
  - 顶层多了一个 `我的上传` tab，仅展示用户从文件管理页直接上传的文件（编辑器粘贴、Tiptap 内联抽取的不计入）
  - 二级子筛选三选一：`全部 / 已引用 / 未引用`，分别对应「上传过的全部 / 已经被某条笔记真正用上 / 还放在这里没插任何笔记」
  - 后端 `GET /api/files` 新增 `filter=myUploads` + `myUploadsRef=referenced|unreferenced`，复用 `attachment_references` 倒排表（`EXISTS / NOT EXISTS` 子查询），避免全表扫 `notes.content`
  - `GET /api/files/stats` 响应增 `myUploads: { total, referenced, unreferenced }` 用于 tab 徽标
  - 与 `孤儿(unreferenced)` 视图的区别：前者在用户**自己上传**的子集内细分；后者是全集合的"没人引用"（含编辑器粘贴又删除的，且有 24h 宽限期）

### 🐛 修复

- **files**: 「我的上传」分支字面量大小写错配，导致筛选完全失效
  - 现象：`?filter=myUploads` 走到后端后被 `.toLowerCase()` 转成 `myuploads`，再与字面量 `"myUploads"`（驼峰）比较 → 永远 false，整个 myUploads 分支变成 dead code，列表退化为返回 scope 全集，「我的上传」展示了 1300+ 张所有附件
  - 修复：把字面量也改成全小写 `"myuploads"`；同时给该分支加注释说明 filter 已 lowercased，避免再次踩坑
  - 教训：query 参数解析阶段统一 lowercased 后，下游所有 case 都必须用小写字面量；驼峰命名的 filter 名（如 `myUploads`）是高危区
  - 配套调试工具：
    - 后端 `GET /api/files` 增加可选调试日志——开启后每次列表请求会打印 `raw`（原始 query）/ `parsed`（解析后小写值）/ `whereSql` / `paramCount`，下次再遇到"前端传了 filter 但后端像没收到"的现象可一眼比对。生产默认关闭，零开销
    - 双源开关：环境变量 `DEBUG_FILES_QUERY=1`（运维侧旁路，需重启）；或 `system_settings.debug_files_query='true'`（运行时持久化，写库后 30s 内全节点生效）
    - 可视化入口：「设置 → 开发者」面板（仅管理员可见）新增 toggle，无需登服务器即可一键开关
    - 后端字段级闸门：`/api/settings` PUT 中 `debug_files_query` 仅 admin 可写，普通用户即使构造请求也会被 403
- **files**: 「我的上传」展示历史脏数据（含浏览器图标 / 误粘贴 / 测试上传等几十张非用户主动上传的图）
  - 根因：旧口径靠 `attachments.noteId == holderNoteId`（"未归档文件"占位笔记），但任何走过 `POST /api/files/upload` 的内容（含 FileManager 页全局 paste 监听器抓到的浏览器图）都会落进同一个 holder，导致"我的上传" tab 把历史粘贴 / 测试数据全部算上
  - 修复：DB 迁移 v12 给 `attachments` 加 `uploadSource TEXT`，仅 `POST /api/files/upload` 写入时标 `'file_manager'`；编辑器粘贴 / 内联抽取等其它路径保持 NULL；老附件**不回填**——历史脏数据自动从「我的上传」中清出
  - dedup 边界：当用户从文件管理主动上传一份内容已存在的文件时，会把命中的老行 `uploadSource` 升级为 `'file_manager'`（这是用户的主动行为，应当被识别）
  - 兼容：老附件仍在「全部 / 图片 / 文件 / 孤儿」等其它 tab 里可见，没有任何数据丢失；holder note（"未归档文件"）保留作为外键容器，不再用作筛选依据

### ⚡ 性能

- **files**: 文件管理图片密集场景全链路优化（图床卡顿专项）
  - 后端新增 `sharp` webp 缩略图服务（`backend/src/services/thumbnails.ts`），按需生成 240/480/960 三档宽度并落盘缓存到 `ATTACHMENTS_DIR/.thumbs/`，与原图共享 `Cache-Control: immutable, 1y`
  - `/api/attachments/:id` 新增 `?w=` 查询参数；`toFileOut` 给 raster 图片下发 `thumbnailUrl`
  - 前端 `GridCard` 用 `React.memo` + 父级派生 `isCopied`/`isDownloading`/`selected` 三个 boolean prop，消除 60+ 张卡的整体重渲
  - `<img>` 优先用 `thumbnailUrl`，加 `decoding="async"` + `fetchpriority="low"`；破图自动回退原图
  - `loadList` 加 30s TTL 模块级缓存，删除/上传/重命名/孤儿清理后清缓存
  - `downloadItem` 用 ref 同步 `downloadingId`，砍掉 useCallback 依赖，避免下载状态变化打穿 memo
  - 附件删除/孤儿清理时连带清缩略图缓存；孤儿扫描跳过 `.thumbs/` 隐藏目录
  - 预期：单页流量 ~200MB → ~2-4MB（100×），交互重渲 60 → 1-2（30×）

## v1.0.38 - 2026-05-14

### ✨ 新增

- **editor**: 顶栏新增 Mermaid / 数学公式 / 脚注 按钮，并让 Mermaid 块可双击编辑 (8970e9c)
- **editor**: Mermaid 图表 / LaTeX 数学公式 / 脚注 三项块级扩展 (530240c)
- **editor**: 链接气泡菜单 + 选区气泡补链接按钮 (ad8d8c8)
- **editor**: markdown 语法与斜杠命令增强 (862047f)

### 🐛 修复

- **release**: frontend 依赖体检白名单补 mermaid/katex/rehype-raw (cbafdc0)
- **backend**: reclaim disk space on note/notebook deletion (3d8e61b)

### ♻️ 重构

- **ai**: 用项目统一 confirmDialog 替代 window.confirm (5088414)

### 💄 样式

- **editor,share**: 编辑器链接醒目化 + 分享页排版自给自足 (e8d6e06)

### 📦 构建

- **clipper**: 0.1.2 多浏览器构建产物（chrome/edge/firefox） (1902bf7)

### 🔧 其他

- **clipper**: release v0.1.2 (01ebf0c)


## v1.0.37 - 2026-05-12

### ✨ 新增

- AI 批量归类加确认面板；剪藏来源用完整 URL；版本提示按版本号去重 (d6b30bd)

### 🐛 修复

- **android**: 修复键盘弹起后输入框下方一大片白色空白 (35cfb74)


## v1.0.36 - 2026-05-12

### ✨ 新增

- **clipper**: AI optimize clipped content via nowen-note backend (fbc1249)
- **frontend**: wire FileManager/TiptapEditor with new attachment refs + i18n (0376a01)
- **backend**: add AI clip-enhance API and attachment/share infra (bb91576)
- **rag**: support xlsx/xlsm/xltx attachment indexing for AI Q&A (d184942)

### 🐛 修复

- **release**: prevent cross-platform native module mismatch in Win installer (5d73e19)

### 🔧 其他

- **clipper**: support Chrome/Edge/Firefox packaging + release v0.1.1 artifacts (10b36d2)


## v1.0.35 - 2026-05-11

### 🐛 修复

- **db**: 修复老库启动崩溃 SqliteError: no such column: workspaceId (d445c10)
- **release**: .fpk 产物只收集当前版本，避免 dist-fpk 历史堆积误传 (4e3bf3b)


## v1.0.34 - 2026-05-11

### 🐛 修复

- **db**: 修复老库启动崩溃 SqliteError: no such column: conversationId (984b1c4)
- **electron**: 修复 Win 安装包启动报 ERR_DLOPEN_FAILED 的根因 (8d2da99)
- **tasks**: 更新任务后同步刷新左侧分组计数（今天/未来7天/已逾期） (b39a825)
- **tasks**: 修复待办按日期分组/展示的时区错位（今天/本周/逾期） (edcc285)


## v1.0.33 - 2026-05-11

### ✨ 新增

- **ai**: 知识问答支持多会话（多聊天并行保存） (d10764c)
- **ai**: 批量 AI 操作（标签/归类） (a11bdc2)
- **ai**: 笔记归类建议（AI 自动目录归类） (313b200)
- **ai**: 自定义指令模板可保存与复用 (2395a93)
- **ai**: RAG 知识库支持附件内容索引（PDF/文本/docx 等） (afdc482)
- **backup**: 自动备份支持每日定时/保留数量/邮件通知 (eded447)
- **users**: 个人空间导出/导入开关下沉为 per-user 字段 (4769c7f)
- **upload**: 附件上传支持拖拽 (beb74d8)
- **ios**: 接入 Capacitor iOS 工程骨架与 GitHub Actions TestFlight 发版 (0320ba8)

### 🐛 修复

- **build**: unpdf 加入 esbuild external 名单，修复后端 bundle 失败 (bb46727)
- **backend**: 修复 backup.ts 重载签名默认参数导致的 TS2371 编译错误 (b69d66a)
- **security**: RAG 知识库索引按工作区/个人空间隔离 (5e5e899)
- **ui**: 修复笔记列表长标题挤掉预览行 (2b9d4c9)
- **ai**: AI 写作助手 markdown 格式化丢失链接和图片 (91e42e4)
- **electron**: 修复 main.js 第 702 行非法字符串导致主进程启动崩溃 (e851eeb)
- **release**: 仅上传当前版本产物到 GitHub Release，避免历史包混入 (91edab8)


## v1.0.32 - 2026-05-09

### ✨ 新增

- **release**: wire NOWEN_BUILD_TIME/APP_VERSION into Docker, add lite/clipper targets (d3ab15f)
- **update**: tighten cross-platform update flow (8b56551)
- **update**: in-app update notifier & clipper pack tweaks (1ba6730)
- **about**: add sponsor QR card in Settings -> About (9f78cd3)

### 🐛 修复

- bug (de5b1dc)
- **update**: suppress banner when appVersion already matches (127c1ee)
- **notes**: enforce workspace isolation on note move (a783d31)
- **clipper**: derive firefox manifest from chrome manifest (bef9e82)
- **attachments**: inherit workspaceId from note on upload (65a71cd)

### 📝 文档

- document fpk one-click install for fnOS (6d7c588)



## v1.0.31 - 2026-05-08

### ✨ 新增

- **about**: add sponsor QR card in Settings -> About (9f78cd3)
- **fpk**: auto-detect fnpack binary by platform and arch (770aa37)
- **release**: atomic publish - fpk before docker push (e262748)
- **release**: 选项 5 严格原子发布，未签名/无产物均不推送 (1abe912)
- **release**: 智能 git pull，支持 diverged 自动 rebase / merge (db99dbb)
- **release**: release.sh 支持 .fpk target；菜单选项 5 与新选项 7 都可打 .fpk (4c4a9db)
- **files**: 图片/文件支持下载（网格 hover、列表操作列、详情抽屉主按钮） (334a934)
- **files**: 新增文件管理模块（列表/分类/搜索/预览/反向引用跳转/上传删除） (adb012f)
- **backup**: 支持导入外部 .bak / .zip 备份到备份仓库 (8571042)
- **smtp**: 数据管理内嵌 SMTP 配置教程入口与常见邮箱速查 (f706e3a)
- **backup/email**: 发送邮箱支持附件格式选择 + QQ/163/Gmail/Outlook SMTP 教程 (713fa6d)
- **backup**: 备份一键发送邮箱 + 管理员 SMTP 邮件通道 (f268fe1)
- **export**: 单笔记导出 PDF/SVG 能力增强 (3a2c80f)
- **electron**: add lite mode (remote server) with runtime switch (1772a49)
- LAN discovery + offline queue + Youdao import + biometric quick login + sort menu fix (12652f3)
- **data-manager**: 替换备份 sudo 弹窗为自定义 Modal，并合入近期多模块改动 (c27db46)
- **editor**: 优化协作横幅与编辑交互体验 (c58365e)
- **ai**: 获取模型下拉自适应弹出方向，避免被底部遮挡 (01b7fea)
- **ai**: 切换服务商时缓存API Key，避免切换后丢失 (24ccbdc)
- 优化笔记切换性能与体验, 新增设置关于页, 命令面板, 动效系统, 桌面端菜单增强 (57ff957)
- web clipper improvements, HTML preview fixes, privacy policy (ccbaa50)
- **discovery**: 局域网 mDNS 自动发现 + 多端发版脚本与打包降噪 (b9179fa)
- **release**: 版本号建议聚合本地/GitHub/Docker Hub 三端 (d1d3845)
- **frontend**: 抽离 ServerAddressInput 与 serverUrl 工具，统一服务器地址解析 (a644b52)
- **mobile**: 键盘弹起时隐藏顶部工具栏并显示底部浮动工具栏 (391e5ab)
- **release**: ARM64 多架构构建 + release.sh 升级 (9715953)
- **editor**: 图片自定义大小 + 对称缩放 + 快捷菜单 + 触屏支持 (074053f)
- 附件存储独立化 + Docker 发布脚手架 (8c0e2d1)
- **security**: 2FA + 会话管理 + 用户删除数据转移 + 多标签同步 等安全加固 (2df2026)
- **editor**: 迁移到 Markdown 编辑器 (f276863)
- **share**: 支持分享笔记可编辑模式与访客昵称 (e7454ef)
- **editor**: 修复缩进与 Tab/Ctrl+S 键盘支持 (76a04df)
- drag sort, editor enhancements, paste fix, delete key, slash commands, canDragSort TDZ fix (90a4337)
- 增加Markdown粘贴自动识别转换提示、斜杠快捷命令菜单及多项UI优化 (5c449f1)
- 阶段四 - Webhook事件系统、审计日志、数据备份恢复、批处理管道、插件系统、OpenAPI规范、MCP Server(22工具)、TypeScript SDK、CLI命令行工具、README全面更新 (cad1786)
- AI功能增强 - 文档智能解析/批量格式化/知识库导入(③⑤⑥) (239b309)
- 移动端全面适配 + Android APK 打包支持 (009fb17)
- 小米云服务导入笔记支持导入笔记图片 (2561b7f)
- support Electron desktop packaging (b70719b)
- add-tag-color-picker-support (897365a)
- add-release-signing-config-for-Android-APK (f819145)
- notebook-icon-picker-and-calendar-view (6400e53)
- add Android Capacitor packaging with server connection support (b43cb18)
- add Electron desktop packaging support - Add electron/main.js (main process: fork backend, create BrowserWindow) - Add electron/builder.config.js (NSIS/DMG/AppImage) - Add electron/icon.png placeholder icon - Support ELECTRON_USER_DATA env for DB and fonts paths - Support FRONTEND_DIST env for static file serving - Add DiaryCenter placeholder component - Add description/author to package.json - Update .gitignore with release/ (8299582)
- remove diary feature, update docs (OnlyOffice -> Univer.js) (bad18fa)
- add diary (Moments) feature - full stack implementation (43e3076)
- add tag delete in sidebar and fix tags lost on note save (729415c)
- add Ctrl+S save shortcut and update README (f520aa0)
- AI 全功能集成 (Phase 1-5) (9f66a75)
- 侧边栏/笔记列表宽度拖拽调整 & 笔记锁定功能 (ab1a1db)
- 集成 ONLYOFFICE 文档中心 - 支持 Word/Excel/PPT 在线编辑 (9265008)
- **mindmap**: 列表右键支持下载 PNG/SVG/xmind 格式 (6d37881)
- 新增思维导图功能，支持增删改查 (8266f68)
- 新增小米云笔记和OPPO云便签导入功能 (6b12d37)
- 新增手机笔记导入支持（小米/OPPO/一加/vivo），支持 HTML 格式导入 (905b16d)
- 笔记本显示笔记数量，支持实时更新 (a0ec85e)
- 字体持久化修复、笔记移动、字数统计、笔记大纲功能 (a078702)
- 站点品牌定制 + 标签引擎 (74cddf9)
- 添加登录认证、设置中心、恢复出厂设置、右键菜单等功能 (53dc315)
- 暗黑模式、待办事项中心、笔记内嵌Task、数据导入导出 (83b6bd5)
- md (70e2c69)
- init MyStation - self-hosted note app with Hono+SQLite backend and React+Tiptap frontend (c0a283f)

### 🐛 修复

- **fpk**: align compose image tag with docker push (v-prefix) (7638896)
- **release**: PC 打包前追加 frontend 依赖齐全性检查 (72e8a5d)
- **api**: 移除 files.list 中对 FileCategory='all' 的过期判断 (f3790be)
- **release**: PC 打包前自动检查并补装 backend 依赖 (fe3c51f)
- **EditorPane**: 修复 selfUser TDZ 报错 (c3b1336)
- **realtime**: 本人编辑时不再误提示 XX 正在编辑/XX 更新了笔记 (946910f)
- **editor**: 列表中图片序号顺延 & 邮箱链接不再误唤起邮件客户端 (d6a3a5f)
- **files**: 挂载 api.files 模块（stats/list/get/remove/upload），修复运行时 undefined (26c3490)
- **sidebar**: 补齐 Inbox 图标 import，修复文件管理入口运行时 ReferenceError (cc909b7)
- **files**: 补齐 filesRouter import，修复启动 ReferenceError (4f5e2d8)
- **backup**: 修复 Windows 下 zip 全量备份恢复 dryRun 报 'unable to open database file' (07120d1)
- 修复 BackupHealth 重复声明和 typeof this.health 编译错误 (8fe21a4)
- 修复 backup.ts 中 typeof this.health 的 TS2304 编译错误 (eb567b2)
- **editor/image**: 修复点击图片直接放大、调不出尺寸手柄的问题 (97ac298)
- **export**: inline attachments as base64; fix underscore escape & double blank lines on round-trip (435eada)
- README (0a3a0d4)
- **editor**: smart toggleHeading and normalize pasted HTML to avoid multi-line paragraph bug (80896c2)
- **editor**: 修复粘贴 Markdown 时 frontmatter 正则误删文档中间内容的问题 (4227eda)
- 任务列表水平居中对齐 (7bb7893)
- 修复选中文字时BubbleMenu工具栏不显示的问题; feat: 优化图片缩放及clipper polyfill (6445c69)
- Android App 图片不显示问题 (27a2e26)
- bug (2115df0)
- release.sh 自动探测 JAVA_HOME, 解决 Android 构建 invalid source release 21 (eb65ccd)
- AppImage fileAssociations ext数组兼容 + 移动端标签区域按钮样式修复 (2370397)
- electron-builder 用 --publish never 替代 -c.publish=never 修复 25.x 校验 (ac0808f)
- 修复 TS 编译错误, release.sh 新增交互式发布模式选择 (604b42e)
- mDNS 名字冲突 (08ea660)
- desktop remote server login + docker vite build (b522944)
- **micloud**: 支持无标题纯图片笔记导入 (fe20a8b)
- **ui**: 修正笔记列表/侧边栏的 flex 截断问题 (d50742b)
- 修复"未来7天"任务统计数量不准确的问题-前端 (bc40448)
- 修复"未来7天"任务统计数量不准确的问题-后端 (61de3fb)
- **ai**: 修复 AI 问答无法检索中文笔记 & 版本历史写入过于频繁 (514de52)
- **editor**: 修复粘贴多行中文文本及 # 附近输入导致的崩溃，补充版本历史面板 i18n (3bcccfa)
- 修复编辑器多个 bug（粘贴崩溃、恢复版本回退、时间偏差、ref 警告） (57c2beb)
- **editor**: 修复编辑期间光标跳行问题，优化导入导出与笔记列表 (9e3c1d6)
- **i18n**: 补齐 zh-CN common 命名空间缺失的 needNotebookFirst 等 key (5d38e91)
- **sidebar**: 优化笔记本拖入父级的命中区域与视觉反馈 (465f7ee)
- **sidebar**: 笔记本拖拽排序后 UI 实时生效 (73c6065)
- **webhook**: 补充 note.trash_emptied 事件类型，修复后端 tsc 编译错误 (31cb393)
- 修复任务列表单行显示与侧边栏小屏交叠问题，新增代码块视图与 Toast 组件 (12eb86d)
- 修复Ollama连接405错误和分享页面无法滚动问题 (348a19f)
- 修复列表标记不显示、任务列表换行及移动端键盘空白问题 (0b46fe4)
- 修复笔记本文件夹中笔记列表缺少滚动条支持的问题，添加min-h-0约束flex子项高度 (9e5110d)
- 修复ai.ts TypeScript编译错误 - mammoth API/类型断言/冗余比较 (b7993f7)
- switch Docker base image from Alpine to Debian slim (5cca40a)
- tag-color-picker-use-portal-to-prevent-overflow-clipping (e9fe628)
- resolve Kotlin stdlib duplicate class conflict in Android build (e435d84)
- skip package-lock.json in Docker build to resolve cross-platform rollup optional dep issue (3aa78cb)
- use npm install instead of npm ci in Dockerfile for cross-platform compatibility (7f38437)
- remove import of non-existent diary route (4609d06)
- regenerate backend package-lock.json to match package.json (0393f27)
- regenerate frontend package-lock.json to match updated package.json (20d6e78)
- exclude /api paths from static file serving in production mode (4eeccae)
- remove @tiptap/pm from manualChunks (missing exports entry) (e6ac348)
- increase Node.js heap memory for frontend build (OOM) (5dc54dc)
- add @univerjs/presets to frontend dependencies (853aed9)
- add word-extractor to backend dependencies (4985075)
- resolve Docker build TypeScript compilation errors (307f041)
- replace npm ci with npm install in Dockerfile for npm version compatibility (93bb0e5)
- 修复打开Word文档时的QuantityCheckError(Nr4)错误`n`n- 将UniverDocEditor和UniverSheetEditor改为React.lazy动态导入`n- 避免Sheets和Docs preset的FUniver.extend()同时执行导致DI冲突`n- 添加Suspense包裹编辑器组件，优化加载体验`n- 配置Vite optimizeDeps keepNames保留class名称便于调试 (2d6b429)
- 修复新建文档空白问题 - 动态生成有效的 docx/xlsx 模板文件 (cb4cb72)
- 修复 OnlyOffice chat/comments 参数废弃警告，移到 permissions 中 (2c4c7e0)
- OnlyOffice 编辑器加载问题 - 动态推算公网地址 + onError 时隐藏 loading (3e17f68)
- 添加 APP_CALLBACK_URL 修复 OnlyOffice 容器间文件下载失败 (26b1d26)
- 移除 ollama 服务和 version 属性，Ollama 由用户自行部署 (e2b089c)
- 修复 Docker 构建缺少 react-markdown 依赖问题 (bfc4660)
- 修复TS2367类型错误，phase条件块中加入error状态 (9480dc7)
- 修复导入 Markdown 后显示 HTML 标签的问题 (8558b12)
- TaskRow 组件添加 PRIORITY_CONFIG 定义修复 TS2304 (4b328f8)
- 将 i18n 依赖移至 frontend/package.json 修复 Docker 构建 (e586990)
- 修复 framer-motion PopChild ref 警告 (83aedca)
- ContextMenu ref 类型兼容性修复（Docker 构建 TS 报错） (9be19e4)

### ⚡ 优化

- optimize build for low-memory server (2G RAM) (16bfef5)

### ♻️ 重构

- **data-manager**: 引入二级 Tab 分栏，降低长页阅读成本 (9e756c8)
- 优化任务统计查询 — 合并5次SQL为1次聚合, 补全 TaskStats.week 类型 (c668822)
- **release**: 合并 build-arm64.sh 到 release.sh (a7669c8)
- diary feature - pagination, optimistic updates, component split (0a0ed8e)
- 移除 OnlyOffice，改用浏览器端 Word/Excel 阅读编辑 (d34d83e)
- rename MyStation to nowen-note across all files (0d392bb)

### 📝 文档

- document fpk one-click install for fnOS (6d7c588)
- 重构 README 并新增英文版、部署指南与截图 (f33ac12)
- 新增微信赞赏码 (b39e7f2)
- declare VOLUME /app/data in Dockerfile and update README notes (e4bb0f2)
- update README with mobile adaptation and Android APK details (df321d5)
- update-readme-moments-calendar-icon-picker (e2de633)
- 全面更新 README，补充 AI/OnlyOffice/Docker架构/数据库设计等完整文档 (fc333cf)
- 更新 README，补充 AI/OnlyOffice/思维导图/任务管理等完整功能文档 (aab67ac)
- 更新 README，添加思维导图、国际化、移动端适配等功能说明 (7ef4f4c)
- 更新 README 文档，添加思维导图、国际化、移动端适配等功能说明 (90329fb)
- 更新README，添加小米云笔记和OPPO云便签导入功能说明 (482318a)
- 添加7种安装部署教程（Windows/Docker/群晖/绿联/飞牛/威联通/极空间） (f59c86c)
- 更新 README，补充认证、右键菜单、待办、数据管理等功能文档 (8251ceb)
- update frontend README with bilingual (CN/EN) documentation (9b69492)

### 📦 构建

- **release**: 支持原子发布 - 三端全部构建成功后才统一推送 (5768769)

### 🤖 CI

- **release**: fix native module rebuild and artifact path (759cac8)

### 🔧 其他

- misc frontend/backend updates (49970a4)
- **fpk**: add 飞牛 NAS .fpk packaging scaffold (v1.0.28) (b1a091c)
- 新增 .mailmap 统一历史作者身份 (0f05587)
- **clipper**: release v0.1.1 (d583449)
- release.sh 自动丢弃未提交改动而非中断 (f5a88c6)
- bump version (a6429e2)
- desktop app overhaul + icon refresh + JWT auto-provision (ef8ae99)
- 配套改动（micloud 路由、i18n、NoteList/Sidebar/TaskCenter、构建配置） (569d50a)
- **frontend**: API 诊断增强与前端杂项改动 (52c627e)
- remove Document Center feature (Univer.js) (abff16f)


