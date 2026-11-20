#!/usr/bin/env python3
"""
为测试账号 nowen 播种「结构参考真实用户、内容全部合成」的数据。

⚠️ 这个脚本会**写生产库**。它只动 userId = nowen 的那一份数据，
   但那仍然是生产库 —— 跑之前请先备份：
       sudo sqlite3 /vol1/1000/docker/nowen-note/data/nowen-note.db \
            ".backup '/path/to/backup.db'"

设计原则
--------
1. **结构照抄，内容零拷贝。** 笔记本层级参考真实用户的目录形状
   （6 个顶层 + 子文件夹 + 一个上千篇的大归档），但**所有标题与正文都是合成的**，
   没有一条来自真实数据。
2. **格式比例对齐真实库。** 实测真实库是 html ≈74% / markdown ≈26% / tiptap-json ≈0.2%，
   这里按同样比例生成 —— 三种渲染路径都能被测到。
3. **幂等。** 重复跑会先清掉 nowen 自己的数据再重建（绝不动别的用户）。
4. **规模可调。** `--scale 2.0` 就是两倍笔记，用来压性能。

用法
----
    # 只生成 SQL，不写库（先看看要做什么）
    python3 scripts/seed-test-account.py --dry-run > /tmp/seed.sql

    # 真写
    python3 scripts/seed-test-account.py --out /tmp/seed.sql
    sudo sqlite3 /vol1/1000/docker/nowen-note/data/nowen-note.db < /tmp/seed.sql
"""
import argparse
import json
import random
import sys
import uuid
from datetime import datetime, timedelta, timezone

DB = "/vol1/1000/docker/nowen-note/data/nowen-note.db"
USERNAME = "nowen"

# ---------------------------------------------------------------------------
# 目录结构：形状参考真实用户，名字是通用分类名
# ---------------------------------------------------------------------------
# (名字, 图标, 笔记数, 内容类型)
TREE = [
    ("📥 00 收件箱", "📥", [
        ("微信收件箱", "💬", 3, "inbox"),
        ("📝 默认笔记", "📝", 2, "inbox"),
        ("🤖 AI 投递", "🤖", 2, "inbox"),
    ]),
    ("🗂 10 工作台", "🗂", [
        ("✍️ 写稿在写", "✍️", 4, "draft"),
        ("🎬 选题与运营", "🎬", 20, "topic"),
        ("📤 发布与分发", "📤", 8, "publish"),
        ("🚧 进行中项目", "🚧", 12, "project"),
    ]),
    ("📚 20 常备资料", "📚", [
        ("⚖️ 应急预案与法律", "⚖️", 5, "legal"),
        ("🏢 公司与工商", "🏢", 20, "company"),
        ("💬 常用话术", "💬", 1, "script"),
        ("💻 开发与自建服务", "💻", 6, "tech"),
        ("🔑 账号与凭据", "🔑", 30, "account"),
        ("🧠 方法论与思想", "🧠", 5, "method"),
        ("🧰 技术运维手册", "🧰", 35, "ops"),
    ]),
    ("📆 30 生活记录", "📆", [
        ("✈️ 旅行", "✈️", 23, "travel"),
        ("🍜 美食", "🍜", 2, "food"),
        ("🎂 生日与纪念日", "🎂", 14, "birthday"),
        ("🏠 生活笔记", "🏠", 9, "life"),
    ]),
    ("📔 40 日记", "📔", [
        ("【日记】TimeLine", "📔", 62, "diary"),
    ]),
    ("🏛 90 归档", "🏛", [
        ("📰 稿件档案", "📰", [
            ("2022", "📁", 10, "archive"),
            ("2023", "📁", 4, "archive"),
            ("2024", "📁", 3, "archive"),
            ("2025", "📁", 40, "archive"),
            ("2026", "📁", 30, "archive"),
            ("📄 个人文集", "📄", 10, "essay"),
        ]),
        ("🗃 旧笔记归档（2014-2021）", "🗃", 400, "bulk"),
    ]),
]

# 标题词库：全部是通用词，不含任何真实内容的痕迹
TITLES = {
    "inbox": ["随手记 · 待整理", "看到一句话", "临时想法", "待归档条目"],
    "draft": ["初稿：结构梳理", "初稿：开头重写", "半成品：参数对比", "素材整理"],
    "topic": ["选题：同价位横评", "选题：新品开箱", "选题：长期使用体验", "选题：避坑指南"],
    "publish": ["发布记录 · 主站", "发布记录 · 短视频", "排期表", "分发渠道备忘"],
    "project": ["项目：桌面收纳改造", "项目：家庭网络整理", "项目：旧硬盘盘点", "项目：订阅清理"],
    "legal": ["劳动合同要点", "租房合同注意项", "应急联系人清单", "常见纠纷处理流程"],
    "company": ["供应商 A 对接记录", "报价单汇总", "合同归档", "工商变更备忘"],
    "script": ["常用沟通话术"],
    "tech": ["自建服务清单", "端口占用备忘", "Docker 常用命令", "反向代理笔记"],
    "account": ["某站点账号备忘", "设备序列号记录", "保修信息", "会员到期提醒"],
    "method": ["做事的原则", "如何做取舍", "复盘的框架", "优先级判断"],
    "ops": ["备份策略", "磁盘健康检查", "服务巡检清单", "故障处理记录"],
    "travel": ["行程规划", "住宿对比", "交通方案", "行李清单", "花费记录"],
    "food": ["常做的菜", "想去的店"],
    "birthday": ["生日备忘", "纪念日提醒", "礼物清单"],
    "life": ["家电清单", "维修记录", "缴费提醒", "收纳方案"],
    "diary": ["今天", "随手一记", "这周"],
    "archive": ["旧文归档", "往期记录", "整理稿"],
    "essay": ["长文：一些观察", "长文：经验总结", "长文：写给未来的自己"],
    "bulk": ["旧笔记", "摘录", "备忘"],  # 大归档，标题后面会拼序号
}

BODY_MD = """# {title}

这是一条**合成**的测试数据，用来验证渲染、搜索与性能，不对应任何真实内容。

## 小标题

- 列表项一，带 `inline code`
- 列表项二，带 **加粗**、*斜体*、~~删除线~~
- 列表项三

> 引用块：合成的测试内容。

```js
// 代码块
const note = {{ id: "{nid}", format: "markdown" }};
console.log(note);
```

| 方案 | 体积 | 评价 |
| --- | --- | --- |
| 方案 A | 1.6 MB | 偏胖 |
| 方案 B | 88 KB | 刚好 |
"""

BODY_HTML = """<h1>{title}</h1>
<p>这是一条<strong>合成</strong>的测试数据，用来验证 HTML 渲染与 XSS 消毒，不对应任何真实内容。</p>
<h2>段落与格式</h2>
<ul><li>列表项一，带 <code>inline code</code></li><li>列表项二，带 <em>斜体</em></li></ul>
<blockquote><p>引用块：合成的测试内容。</p></blockquote>
<table><thead><tr><th>方案</th><th>体积</th><th>评价</th></tr></thead>
<tbody><tr><td>方案 A</td><td>1.6 MB</td><td>偏胖</td></tr>
<tr><td>方案 B</td><td>88 KB</td><td>刚好</td></tr></tbody></table>
<pre><code>const note = {{ id: "{nid}", format: "html" }};</code></pre>
"""


def tiptap_doc(title: str, nid: str) -> str:
    """合法的 tiptap JSON —— 服务端与前端都按这个结构解析"""
    return json.dumps(
        {
            "type": "doc",
            "content": [
                {"type": "heading", "attrs": {"level": 1},
                 "content": [{"type": "text", "text": title}]},
                {"type": "paragraph", "content": [
                    {"type": "text", "text": "这是一条"},
                    {"type": "text", "marks": [{"type": "bold"}], "text": "合成"},
                    {"type": "text", "text": f"的测试数据（富文本格式），id={nid}。"},
                ]},
                {"type": "bulletList", "content": [
                    {"type": "listItem", "content": [{"type": "paragraph",
                     "content": [{"type": "text", "text": "列表项一"}]}]},
                    {"type": "listItem", "content": [{"type": "paragraph",
                     "content": [{"type": "text", "text": "列表项二"}]}]},
                ]},
            ],
        },
        ensure_ascii=False,
    )


def plain_text(title: str, kind: str) -> str:
    """contentText —— 搜索与列表摘要用的纯文本。直接插库时必须自己给。"""
    return (
        f"{title}。这是一条合成的测试数据，用来验证渲染、搜索与性能，"
        f"不对应任何真实内容。分类：{kind}。"
    )


def sql_quote(v) -> str:
    if v is None:
        return "NULL"
    if isinstance(v, (int, float)):
        return str(v)
    return "'" + str(v).replace("'", "''") + "'"


def pick_format(rng: random.Random) -> str:
    """对齐真实库的格式比例：html 74% / markdown 26% / tiptap-json 少量"""
    r = rng.random()
    if r < 0.005:
        return "tiptap-json"
    if r < 0.745:
        return "html"
    return "markdown"


def build(scale: float, seed: int, uid_expr: str) -> tuple[list[str], dict]:
    """uid_expr 是一段【SQL 表达式】—— 调用方决定要不要加引号，这里一律原样拼。"""
    rng = random.Random(seed)
    uid = uid_expr
    stmts: list[str] = []
    stats = {"notebooks": 0, "notes": 0, "by_format": {}, "empty_notebooks": 0, "diaries": 0}
    # ⚠️ 必须是 **UTC**。服务端的 createdAt/updatedAt 存的是裸 UTC
    #    （实测 /api/notes 新建后返回的值就等于当下 UTC），
    #    用本地时间写进去会让所有时间偏一个时区（东八区偏 8 小时，
    #    「刚刚」变成「8 小时前」）。
    now = datetime.now(timezone.utc).replace(tzinfo=None)

    def add_notebook(nb_id: str, parent: str | None, name: str, icon: str, order: int) -> None:
        stmts.append(
            "INSERT INTO notebooks (id, userId, parentId, name, description, icon, color, "
            "sortOrder, isExpanded, isDeleted, createdAt, updatedAt) VALUES ("
            f"{sql_quote(nb_id)}, {uid}, {sql_quote(parent)}, {sql_quote(name)}, "
            f"NULL, {sql_quote(icon)}, NULL, {order}, 1, 0, "
            f"{sql_quote(now.strftime('%Y-%m-%d %H:%M:%S'))}, "
            f"{sql_quote(now.strftime('%Y-%m-%d %H:%M:%S'))});"
        )
        stats["notebooks"] += 1

    def add_note(nb_id: str, title: str, kind: str, idx: int) -> None:
        nid = str(uuid.uuid4())
        fmt = pick_format(rng)
        if fmt == "tiptap-json":
            content = tiptap_doc(title, nid)
        elif fmt == "html":
            content = BODY_HTML.format(title=title, nid=nid)
        else:
            content = BODY_MD.format(title=title, nid=nid)

        # 时间铺开在最近两年，让「相对时间」和排序看起来真实
        age_days = rng.randint(0, 730)
        created = now - timedelta(days=age_days, minutes=rng.randint(0, 1440))
        updated = created + timedelta(minutes=rng.randint(0, 60 * 24 * 30))
        if updated > now:
            updated = now

        is_pinned = 1 if rng.random() < 0.02 else 0
        stats["by_format"][fmt] = stats["by_format"].get(fmt, 0) + 1
        stats["notes"] += 1

        stmts.append(
            "INSERT INTO notes (id, userId, notebookId, title, content, contentText, "
            "isPinned, isFavorite, isLocked, isArchived, isTrashed, version, sortOrder, "
            "createdAt, updatedAt, workspaceId, contentFormat, note_type, colorMark) VALUES ("
            f"{sql_quote(nid)}, {uid}, {sql_quote(nb_id)}, {sql_quote(title)}, "
            f"{sql_quote(content)}, {sql_quote(plain_text(title, kind))}, "
            f"{is_pinned}, 0, 0, 0, 0, 1, {idx}, "
            f"{sql_quote(created.strftime('%Y-%m-%d %H:%M:%S'))}, "
            f"{sql_quote(updated.strftime('%Y-%m-%d %H:%M:%S'))}, NULL, "
            f"{sql_quote(fmt)}, 'normal', NULL);"
        )

    def walk(node, parent_id: str | None, order: int) -> None:
        """node = (name, icon, children_or_count, kind)"""
        name, icon, payload, *rest = node
        kind = rest[0] if rest else None
        nb_id = str(uuid.uuid4())
        add_notebook(nb_id, parent_id, name, icon, order)
        if isinstance(payload, list):
            # 它是父文件夹：payload 是子节点列表
            for i, child in enumerate(payload):
                walk(child, nb_id, i)
        else:
            count = max(0, int(round(payload * scale)))
            if count == 0:
                stats["empty_notebooks"] += 1
            pool = TITLES.get(kind or "inbox", TITLES["inbox"])
            for i in range(count):
                if kind == "bulk":
                    title = f"{pool[i % len(pool)]} {i + 1:04d}"
                elif kind == "diary":
                    d = now - timedelta(days=count - i)
                    title = f"{d.strftime('%Y-%m-%d')} {pool[i % len(pool)]}"
                else:
                    base = pool[i % len(pool)]
                    title = base if count <= len(pool) else f"{base}（{i + 1}）"
                add_note(nb_id, title, kind or "inbox", i)

    # TREE 里的节点有两种形状：顶层是 (name, icon, children)，
    # 子节点是 (name, icon, count, kind) 或 (name, icon, 子列表)
    for i, entry in enumerate(TREE):
        name, icon, payload = entry
        folder_id = str(uuid.uuid4())
        add_notebook(folder_id, None, name, icon, i)
        for j, child in enumerate(payload):
            walk(child, folder_id, j)

    # ---- 说说：跨若干天，用来验证「按日期分块」 ----
    #  使用服务端支持的 createdAt 补录；同样必须是 UTC。
    diary_specs = [
        (0, "今天：用测试账号验证 Lite 的说说功能。", "😀"),
        (0, "今天第二条 —— 验证同一天会归到同一块。", "🔥"),
        (1, "昨天：记一条。", "🙂"),
        (3, "三天前：刚给测试账号播种完合成笔记。", "📚"),
        (3, "同一天的第二条。", "☕"),
        (9, "上周的一条。", "🌱"),
        (40, "更早的一条 —— 用来验证较远日期显示成「月 日 周X」。", "🗓"),
        (400, "跨年的一条 —— 用来验证显示成「YYYY 年 M 月 D 日 周X」。", "📦"),
    ]
    for days, text, mood in diary_specs:
        created = now - timedelta(days=days, minutes=rng.randint(0, 600))
        stmts.append(
            "INSERT INTO diaries (id, userId, workspaceId, contentText, mood, images, media, "
            "createdAt) VALUES ("
            f"{sql_quote(str(uuid.uuid4()))}, {uid}, NULL, {sql_quote(text)}, {sql_quote(mood)}, "
            f"'[]', '[]', {sql_quote(created.strftime('%Y-%m-%d %H:%M:%S'))});"
        )
        stats["diaries"] = stats.get("diaries", 0) + 1

    return stmts, stats


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--scale", type=float, default=1.0, help="笔记数量倍数，默认 1.0")
    ap.add_argument("--seed", type=int, default=20261007, help="随机种子（保证可复现）")
    ap.add_argument("--uid", help=f"{USERNAME} 的 userId（不传则用 SQL 子查询自动取）")
    ap.add_argument("--out", help="写到这个文件；不传则打到 stdout")
    ap.add_argument("--dry-run", action="store_true", help="只生成，不写库（等价于打到 stdout）")
    args = ap.parse_args()

    # uid 不传就交给 SQL 自己查 —— 避免把 id 写死在命令行里
    uid_expr = sql_quote(args.uid) if args.uid else f"(SELECT id FROM users WHERE username='{USERNAME}')"
    stmts, stats = build(args.scale, args.seed, uid_expr)
    body = "\n".join(stmts)

    header = f"""-- 测试账号 {USERNAME} 的合成数据
-- 由 scripts/seed-test-account.py 生成（scale={args.scale} seed={args.seed}）
--
-- ⚠️ 只动 {USERNAME} 自己的数据；先清空再重建，可重复运行。
BEGIN;
-- 只删这一个用户的数据（级联会带走 notes / notebooks）
DELETE FROM attachments WHERE userId = {uid_expr};
DELETE FROM diaries     WHERE userId = {uid_expr};
DELETE FROM notes      WHERE userId = {uid_expr};
DELETE FROM notebooks  WHERE userId = {uid_expr};
-- 首次登录自动播种的「使用指南」也一并清掉，避免和参考结构混在一起
DELETE FROM notebooks  WHERE userId = {uid_expr} AND id LIKE 'onboarding-v1-%';
"""
    footer = "COMMIT;\n"

    sql = header + body + "\n" + footer

    if args.out:
        with open(args.out, "w", encoding="utf-8") as fh:
            fh.write(sql)
        print(f"  ✓ SQL 已写入 {args.out}", file=sys.stderr)
    else:
        sys.stdout.write(sql)

    print(
        f"  笔记本 {stats['notebooks']} 个（其中空笔记本 {stats['empty_notebooks']} 个）"
        f" / 笔记 {stats['notes']} 篇 / 说说 {stats.get('diaries', 0)} 条",
        file=sys.stderr,
    )
    by = ", ".join(f"{k} {v}" for k, v in sorted(stats["by_format"].items(), key=lambda x: -x[1]))
    print(f"  格式分布：{by}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
