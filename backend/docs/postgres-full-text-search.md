# PostgreSQL 全文搜索（Issue #252）

`pg-migration-unified` 的 PostgreSQL Runtime 使用原生 `tsvector` / `tsquery`，不复制 SQLite FTS5 虚拟表。

## 索引

- `notes.searchVector`：生成列，标题权重 A、正文 `contentText` 权重 B。
- `idx_notes_search_vector`：笔记 GIN 索引。
- 标签名、附件名、附件分块正文分别建立 GIN 表达式索引。
- 统一采用 `simple` 配置，避免英文词干化改变代码、版本号和标识符语义。

## 查询兼容

`GET /api/search?q=...&workspaceId=...` 保留原有返回字段、HTML 高亮和 100 条上限。候选集由 PostgreSQL 全文检索与受限字面量检索共同产生，随后在应用层使用 NFKC、大小写折叠和零宽字符清理规则验证每个查询词。

字面量兜底用于：

- 中文；
- 少于 3 个字符的词；
- `C++`、`foo-bar` 等标点敏感词；
- PostgreSQL parser 无法完整保留的 token。

这会让中文与代码类查询保持可用，同时让普通英文查询优先走 GIN 索引。

## 运维接口

- `GET /api/search/health`：检查生成列、GIN 索引及索引覆盖数。
- `POST /api/search/rebuild`：管理员执行 `REINDEX` 和 `ANALYZE`。

PostgreSQL 的排序使用 `ts_rank_cd`，与 SQLite FTS5 `bm25` 的绝对分值不同；接口只依赖相对顺序，不向客户端暴露原始分值。
