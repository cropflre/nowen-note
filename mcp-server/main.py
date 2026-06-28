"""
nowen-mcp MCP Server

为 Hermes Agent 提供 nowen-note 的 MCP 工具接口。
通过直接连接 nowen-note SQLite 数据库实现读写操作。

配置 (通过环境变量):
  NOWEN_DB_PATH: nowen-note 数据库路径
  NOWEN_MD_ROOT: MD 文件根目录（写操作需要）
"""

from __future__ import annotations

import json
import os
import sqlite3
import subprocess
import sys
import textwrap
from datetime import datetime
from pathlib import Path
from typing import Any

from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import (
    TextContent,
    Tool,
)

# ── 配置 ──────────────────────────────────────────────────────────────────

DB_PATH = os.environ.get("NOWEN_DB_PATH", "")
MD_ROOT = os.environ.get("NOWEN_MD_ROOT", "")

if not DB_PATH:
    # 尝试从默认路径推断
    default = str(Path.home() / "projects/nowen-note/backend/data/nowen-note.db")
    if os.path.exists(default):
        DB_PATH = default

if not os.path.exists(DB_PATH):
    print(f"⚠️  NOWEN_DB_PATH 未设置或文件不存在: {DB_PATH}", file=sys.stderr)

# ── 数据库连接 ─────────────────────────────────────────────────────────────

_conn: sqlite3.Connection | None = None


def get_db() -> sqlite3.Connection:
    global _conn
    if _conn is None:
        _conn = sqlite3.connect(DB_PATH)
        _conn.row_factory = sqlite3.Row
        _conn.execute("PRAGMA journal_mode=WAL")
    return _conn


def dict_fetch_all(cursor: sqlite3.Cursor) -> list[dict[str, Any]]:
    return [dict(row) for row in cursor.fetchall()]


# ── FTS5 搜索 ─────────────────────────────────────────────────────────────


def search_notes_fts5(query: str, limit: int = 10) -> list[dict[str, Any]]:
    """使用 FTS5 全文搜索笔记"""
    db = get_db()
    try:
        # 对查询做简单转义（FTS5 使用双引号语法）
        safe_query = query.replace('"', '""')
        rows = db.execute(
            """
            SELECT n.id, n.title, n.contentText, n.notebookId, n.isArchived,
                   n.createdAt, n.updatedAt, nb.name as notebookName,
                   snippet(notes_fts, 1, '<mark>', '</mark>', '...', 44) as snippet
            FROM notes n
            JOIN notes_fts ON notes_fts.rowid = n.rowid
            LEFT JOIN notebooks nb ON nb.id = n.notebookId
            WHERE notes_fts MATCH ?
              AND n.userId = (SELECT id FROM users LIMIT 1)
              AND n.isTrashed = 0
            ORDER BY rank
            LIMIT ?
            """,
            (safe_query, limit),
        )
        return dict_fetch_all(rows)
    except sqlite3.OperationalError as e:
        # FTS5 语法错误时的降级搜索
        keyword = query.strip().split()[0] if query.strip() else ""
        if not keyword:
            return []
        rows = db.execute(
            """
            SELECT n.id, n.title, n.contentText, n.notebookId, n.isArchived,
                   n.createdAt, n.updatedAt, nb.name as notebookName
            FROM notes n
            LEFT JOIN notebooks nb ON nb.id = n.notebookId
            WHERE (n.title LIKE ? OR n.contentText LIKE ?)
              AND n.userId = (SELECT id FROM users LIMIT 1)
              AND n.isTrashed = 0
            ORDER BY n.updatedAt DESC
            LIMIT ?
            """,
            (f"%{keyword}%", f"%{keyword}%", limit),
        )
        return dict_fetch_all(rows)


def search_semantic(query: str, limit: int = 5) -> list[dict[str, Any]]:
    """语义搜索（降级到普通查询）"""
    db = get_db()
    try:
        rows = db.execute(
            """
            SELECT n.id, n.title, n.contentText, n.notebookId,
                   nb.name as notebookName
            FROM notes n
            LEFT JOIN notebooks nb ON nb.id = n.notebookId
            WHERE n.isTrashed = 0
              AND n.userId = (SELECT id FROM users LIMIT 1)
            ORDER BY n.updatedAt DESC
            LIMIT ?
            """,
            (limit,),
        )
        return [dict(row) for row in rows]
    except Exception:
        return []


# ── 写操作：创建 / 更新 MD 文件 ──────────────────────────────────────────


def write_md_file(relative_path: str, content: str) -> str:
    """写入 MD 文件到 MD_ROOT 目录"""
    if not MD_ROOT:
        raise ValueError("NOWEN_MD_ROOT 未设置，无法写入 MD 文件")

    full_path = Path(MD_ROOT) / relative_path
    full_path.parent.mkdir(parents=True, exist_ok=True)
    full_path.write_text(content, encoding="utf-8")
    return str(full_path)


def format_frontmatter(
    title: str,
    tags: list[str] | None = None,
    **extra,
) -> str:
    """生成 YAML frontmatter 字符串"""
    lines = ["---"]
    lines.append(f"title: {title}")
    lines.append(f"created: {datetime.now().isoformat()}")
    lines.append(f"updated: {datetime.now().isoformat()}")
    if tags:
        lines.append(f"tags: [{', '.join(tags)}]")
    for key, value in extra.items():
        if value is not None:
            lines.append(f"{key}: {value}")
    lines.append("---")
    return "\n".join(lines)


def get_notebook_path(notebook_name: str | None) -> str:
    """笔记本名 → 目录路径"""
    return notebook_name.replace("/", "/") if notebook_name else ""


# ── MCP Server ────────────────────────────────────────────────────────────

app = Server("nowen-note")


@app.list_tools()
async def list_tools() -> list[Tool]:
    return [
        Tool(
            name="nowen_search",
            description="全文搜索笔记。对笔记标题和内容进行 FTS5 搜索",
            inputSchema={
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "搜索关键词（支持 FTS5 语法：AND OR 双引号短语）",
                    },
                    "limit": {
                        "type": "integer",
                        "description": "返回结果数，默认 10",
                        "default": 10,
                    },
                },
                "required": ["query"],
            },
        ),
        Tool(
            name="nowen_read",
            description="读取单篇笔记的完整内容（含 frontmatter 和正文）",
            inputSchema={
                "type": "object",
                "properties": {
                    "note_id": {
                        "type": "string",
                        "description": "笔记 ID（UUID）",
                    },
                },
                "required": ["note_id"],
            },
        ),
        Tool(
            name="nowen_list",
            description="列出笔记。可按笔记本过滤",
            inputSchema={
                "type": "object",
                "properties": {
                    "notebook": {
                        "type": "string",
                        "description": "笔记本名称过滤（可选，如 '编程/TypeScript'）",
                    },
                    "limit": {
                        "type": "integer",
                        "description": "返回结果数，默认 20",
                        "default": 20,
                    },
                    "offset": {
                        "type": "integer",
                        "description": "分页偏移，默认 0",
                        "default": 0,
                    },
                },
            },
        ),
        Tool(
            name="nowen_tags",
            description="列出所有标签及其使用次数",
            inputSchema={
                "type": "object",
                "properties": {},
            },
        ),
        Tool(
            name="nowen_tasks",
            description="列出笔记中的待办任务",
            inputSchema={
                "type": "object",
                "properties": {
                    "status": {
                        "type": "string",
                        "description": "过滤：pending (未完成) / completed (已完成) / all (全部)",
                        "default": "pending",
                    },
                    "limit": {
                        "type": "integer",
                        "description": "返回结果数，默认 20",
                        "default": 20,
                    },
                },
            },
        ),
        Tool(
            name="nowen_create",
            description="创建一篇新笔记。写入 MD 文件并自动同步到数据库",
            inputSchema={
                "type": "object",
                "properties": {
                    "title": {
                        "type": "string",
                        "description": "笔记标题",
                    },
                    "content": {
                        "type": "string",
                        "description": "笔记正文（Markdown 格式）",
                    },
                    "notebook": {
                        "type": "string",
                        "description": "笔记本路径（如 '编程/TypeScript'）",
                    },
                    "tags": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "标签列表",
                    },
                    "source": {
                        "type": "string",
                        "description": "来源 URL",
                    },
                },
                "required": ["title"],
            },
        ),
        Tool(
            name="nowen_status",
            description="查看扫描器状态（索引文件数、上次扫描时间）",
            inputSchema={
                "type": "object",
                "properties": {},
            },
        ),
    ]


@app.call_tool()
async def call_tool(name: str, arguments: dict[str, Any]) -> list[TextContent]:
    if name == "nowen_search":
        return [TextContent(type="text", text=json.dumps(
            search_notes_fts5(arguments["query"], arguments.get("limit", 10)),
            ensure_ascii=False, indent=2,
        ))]

    elif name == "nowen_read":
        note_id = arguments["note_id"]
        db = get_db()
        row = db.execute(
            "SELECT * FROM notes WHERE id = ?", (note_id,)
        ).fetchone()
        if not row:
            return [TextContent(type="text", text=f"笔记未找到: {note_id}")]
        note = dict(row)
        # 获取标签
        tags = db.execute(
            "SELECT t.name FROM note_tags nt JOIN tags t ON t.id = nt.tagId WHERE nt.noteId = ?",
            (note_id,),
        ).fetchall()
        note["tags"] = [t["name"] for t in tags]
        return [TextContent(type="text", text=json.dumps(
            note, ensure_ascii=False, indent=2, default=str,
        ))]

    elif name == "nowen_list":
        limit = arguments.get("limit", 20)
        offset = arguments.get("offset", 0)
        notebook_filter = arguments.get("notebook")
        db = get_db()

        if notebook_filter:
            rows = db.execute(
                """
                SELECT n.id, n.title, nb.name as notebookName, n.isArchived,
                       n.createdAt, n.updatedAt, length(n.content) as charCount
                FROM notes n
                LEFT JOIN notebooks nb ON nb.id = n.notebookId
                WHERE nb.name = ?
                  AND n.userId = (SELECT id FROM users LIMIT 1)
                  AND n.isTrashed = 0
                ORDER BY n.updatedAt DESC
                LIMIT ? OFFSET ?
                """,
                (notebook_filter, limit, offset),
            )
        else:
            rows = db.execute(
                """
                SELECT n.id, n.title, nb.name as notebookName, n.isArchived,
                       n.createdAt, n.updatedAt, length(n.content) as charCount
                FROM notes n
                LEFT JOIN notebooks nb ON nb.id = n.notebookId
                WHERE n.userId = (SELECT id FROM users LIMIT 1)
                  AND n.isTrashed = 0
                ORDER BY n.updatedAt DESC
                LIMIT ? OFFSET ?
                """,
                (limit, offset),
            )
        return [TextContent(type="text", text=json.dumps(
            dict_fetch_all(rows), ensure_ascii=False, indent=2,
        ))]

    elif name == "nowen_tags":
        db = get_db()
        cursor = db.execute(
            """
            SELECT t.name, t.color, t.id,
                   (SELECT COUNT(*) FROM note_tags nt WHERE nt.tagId = t.id) as usageCount
            FROM tags t
            WHERE t.userId = (SELECT id FROM users LIMIT 1)
            ORDER BY usageCount DESC
            """,
        )
        return [TextContent(type="text", text=json.dumps(
            dict_fetch_all(cursor), ensure_ascii=False, indent=2,
        ))]

    elif name == "nowen_tasks":
        db = get_db()
        status = arguments.get("status", "pending")
        limit = arguments.get("limit", 20)

        # 使用 notes 表中的 contentText 来解析任务（简化版）
        # 实际任务数据存储在 tasks 表中（nowen-note 的 schema）
        # 先检查 tasks 表
        try:
            tasks_exist = db.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='tasks'"
            ).fetchone()
        except Exception:
            tasks_exist = None

        if tasks_exist:
            if status == "completed":
                completed = 1
            elif status == "pending":
                completed = 0
            else:
                completed = None
            if completed is not None:
                rows = db.execute(
                    """
                    SELECT t.id, t.title, t.completed, t.priority,
                           t.dueDate, n.title as noteTitle
                    FROM tasks t
                    JOIN notes n ON n.id = t.noteId
                    WHERE t.completed = ?
                      AND n.isTrashed = 0
                    ORDER BY t.completed, t.priority, t.dueDate
                    LIMIT ?
                    """,
                    (completed, limit),
                )
            else:
                rows = db.execute(
                    """
                    SELECT t.id, t.title, t.completed, t.priority,
                           t.dueDate, n.title as noteTitle
                    FROM tasks t
                    JOIN notes n ON n.id = t.noteId
                    WHERE n.isTrashed = 0
                    ORDER BY t.completed, t.priority, t.dueDate
                    LIMIT ?
                    """,
                    (limit,),
                )
            return [TextContent(type="text", text=json.dumps(
                dict_fetch_all(rows), ensure_ascii=False, indent=2,
            ))]
        else:
            # 降级：从 contentText 中解析 - [ ] 任务
            rows = db.execute(
                """
                SELECT id, title, content
                FROM notes
                WHERE content LIKE '%[- [ ]%'
                  AND isTrashed = 0
                ORDER BY updatedAt DESC
                LIMIT ?
                """,
                (limit,),
            )
            tasks_found = []
            for row in rows:
                note = dict(row)
                content = note.get("content", "")
                for line in content.split("\n"):
                    stripped = line.strip()
                    if stripped.startswith("- [") or stripped.startswith("* ["):
                        tasks_found.append({
                            "noteId": note["id"],
                            "noteTitle": note["title"],
                            "task": stripped,
                        })
            return [TextContent(type="text", text=json.dumps(
                tasks_found, ensure_ascii=False, indent=2,
            ))]

    elif name == "nowen_create":
        title = arguments["title"]
        content = arguments.get("content", "")
        notebook = arguments.get("notebook", "")
        tags = arguments.get("tags", [])
        source = arguments.get("source", "")

        # 从标题生成文件名
        safe_filename = title.replace("/", "-").replace("\\", "-")
        filename = f"{safe_filename}.md"

        # 构建笔记本目录路径
        notebook_dir = notebook.replace("/", "/") if notebook else ""
        relative_path = f"{notebook_dir}/{filename}" if notebook_dir else filename

        # 生成 frontmatter + 正文
        fm = format_frontmatter(
            title=title,
            tags=tags,
            source=source or None,
        )
        md_content = f"{fm}\n\n{content}"

        # 写入 MD 文件
        file_path = write_md_file(relative_path, md_content)

        return [TextContent(type="text", text=json.dumps({
            "success": True,
            "file_path": file_path,
            "title": title,
            "message": "MD 文件已创建，等待 300ms 后自动同步到数据库",
        }, ensure_ascii=False, indent=2))]

    elif name == "nowen_status":
        db = get_db()
        try:
            total_notes = db.execute(
                "SELECT COUNT(*) as c FROM notes WHERE isTrashed = 0"
            ).fetchone()["c"]
            total_tags = db.execute(
                "SELECT COUNT(*) as c FROM tags"
            ).fetchone()["c"]
            notebooks = dict_fetch_all(db.execute(
                "SELECT id, name FROM notebooks WHERE isDeleted = 0"
            ))
            return [TextContent(type="text", text=json.dumps({
                "notes_count": total_notes,
                "tags_count": total_tags,
                "notebooks": [n["name"] for n in notebooks],
                "db_path": DB_PATH,
                "md_root": MD_ROOT or "(未设置)",
            }, ensure_ascii=False, indent=2))]
        except Exception as e:
            return [TextContent(type="text", text=f"获取状态失败: {e}")]

    else:
        return [TextContent(type="text", text=f"未知工具: {name}")]


async def main():
    async with stdio_server() as (read_stream, write_stream):
        await app.run(read_stream, write_stream, app.create_initialization_options())


if __name__ == "__main__":
    import asyncio
    asyncio.run(main())
