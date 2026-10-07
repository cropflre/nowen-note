/**
 * 本地 Mock Nowen API —— 仅用于开发期 UI 验证
 *
 * 为什么要它：
 *   真实验证「登录 → 笔记本 → 笔记列表 → 阅读（三种格式）」需要账号，
 *   而账号开着 2FA、也不该把密码交给脚本。
 *   所以起一个极小的 mock，让 dev server 把 /api 代理到这里，
 *   就能把整条链路（含 iframe/图片/渲染）在真实浏览器里跑通。
 *
 * ⚠️ 它不连任何真实数据，纯粹是测试夹具。
 *
 *   node scripts/mock-api.mjs 3999
 *   NOWEN_LITE_BACKEND=http://127.0.0.1:3999 npm run dev
 */
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

const PORT = Number(process.argv[2] || 3999);

// ---------- 夹具数据 ----------

// ⚠️ 形状必须与真实 API 一致：**平铺数组 + parentId**，不是嵌套 children。
//    （backend/src/routes/notebooks.ts 直接 `return c.json(rows)`）
//    noteCount 也是**递归**的：父笔记本包含子孙笔记本的笔记数。
const NOTEBOOKS = [
  { id: "nb-tech", userId: "u1", name: "技术笔记", icon: "💻", color: "#4f6bed", parentId: null, sortOrder: 0, noteCount: 3, isDeleted: 0, createdAt: "", updatedAt: "" },
  { id: "nb-life", userId: "u1", name: "生活记录", icon: "🌱", color: "#4caf50", parentId: null, sortOrder: 1, noteCount: 1, isDeleted: 0, createdAt: "", updatedAt: "" },
  { id: "nb-travel", userId: "u1", name: "旅行", icon: "✈️", color: "#ff9800", parentId: "nb-life", sortOrder: 0, noteCount: 1, isDeleted: 0, createdAt: "", updatedAt: "" },
  // 批量空笔记本 —— 贴近真实数据（实测 166 个笔记本里 144 个只有 ≤2 篇笔记、32 个全空），
  // 也用来验证「笔记本搜索」与「一键隐藏空笔记本」这两条在上百个笔记本时才用得上的路径。
  ...Array.from({ length: 11 }, (_, i) => ({
    id: `nb-empty-${i + 1}`,
    userId: "u1",
    name: `${["剪藏", "导入", "临时", "归档", "待整理"][i % 5]}笔记本 ${i + 1}`,
    icon: "📁",
    color: null,
    parentId: i === 0 ? "nb-life" : null,
    sortOrder: 10 + i,
    noteCount: 0,
    isDeleted: 0,
    createdAt: "",
    updatedAt: "",
  })),
];

const MARKDOWN_NOTE = `# 移动端开发踩坑记录

这是 **Markdown** 格式的笔记，用来验证 Lite 的渲染。

## 二级标题

- 列表项一
- 列表项二，带 \`行内代码\`
- **加粗**、*斜体*、~~删除线~~

> 引用块：Lite 的目标是「小而直观」。

\`\`\`js
// 代码块
const x = 1;
console.log(x);
\`\`\`

| 方案 | 体积 | 评价 |
|---|---|---|
| Fork 前端 | 1.6MB | 太胖 |
| SDK 薄壳 | 76KB | 就它了 |

图片引用（相对路径，需要换签名 URL）：
![示例图](/api/attachments/11111111-2222-3333-4444-555555555555)
`;

const HTML_NOTE = `<h1>网页剪藏：一篇长文</h1>
<p>这是 <b>HTML</b> 格式的笔记（你库里 69.6% 都是这种）。</p>
<h2>小标题</h2>
<ul><li>剪藏会带内联样式</li><li>结构可能比较随意</li></ul>
<blockquote><p>Lite 需要能安全地渲染它们。</p></blockquote>
<p>带 <code>inline code</code> 和 <a href="https://example.com">外链</a>。</p>
<table><thead><tr><th>项</th><th>值</th></tr></thead><tbody><tr><td>格式</td><td>html</td></tr></tbody></table>
<p><img src="/api/attachments/11111111-2222-3333-4444-555555555555" alt="剪藏图片"></p>
<script>alert("这段脚本必须被 DOMPurify 清掉")</script>
`;

const TIPTAP_NOTE = JSON.stringify({
  type: "doc",
  content: [
    { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "富文本笔记（tiptap-json）" }] },
    { type: "paragraph", content: [
      { type: "text", text: "这是 " },
      { type: "text", marks: [{ type: "bold" }], text: "加粗" },
      { type: "text", text: " 和 " },
      { type: "text", marks: [{ type: "italic" }], text: "斜体" },
      { type: "text", text: "，还有 " },
      { type: "text", marks: [{ type: "code" }], text: "行内代码" },
      { type: "text", text: "。" },
    ] },
    { type: "bulletList", content: [
      { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "第一项" }] }] },
      { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "第二项" }] }] },
    ] },
    { type: "blockquote", content: [{ type: "paragraph", content: [{ type: "text", text: "引用一段话。" }] }] },
    { type: "codeBlock", content: [{ type: "text", text: "console.log('hi')" }] },
    { type: "image", attrs: { src: "/api/attachments/11111111-2222-3333-4444-555555555555", alt: "富文本图片" } },
    { type: "horizontalRule" },
    { type: "paragraph", content: [{ type: "text", text: "未知节点测试：" }, { type: "mention", attrs: { id: "u9" } }] },
  ],
});

const NOTES = {
  "note-md": {
    id: "note-md", userId: "u1", notebookId: "nb-tech", title: "移动端开发踩坑记录",
    content: MARKDOWN_NOTE, contentText: "移动端开发踩坑记录 这是 Markdown 格式的笔记",
    contentFormat: "markdown", isPinned: 1, isFavorite: 0, isLocked: 0, isTrashed: 0, version: 3,
    createdAt: sqlTime(3600), updatedAt: sqlTime(3600),
  },
  "note-html": {
    id: "note-html", userId: "u1", notebookId: "nb-tech", title: "网页剪藏：一篇长文",
    content: HTML_NOTE, contentText: "网页剪藏 一篇长文 这是 HTML 格式的笔记",
    contentFormat: "html", isPinned: 0, isFavorite: 1, isLocked: 0, isTrashed: 0, version: 1,
    createdAt: sqlTime(86_400), updatedAt: sqlTime(86_400),
  },
  "note-tiptap": {
    id: "note-tiptap", userId: "u1", notebookId: "nb-tech", title: "富文本笔记（tiptap-json）",
    content: TIPTAP_NOTE, contentText: "富文本笔记 这是加粗和斜体",
    contentFormat: "tiptap-json", isPinned: 0, isFavorite: 0, isLocked: 0, isTrashed: 0, version: 1,
    createdAt: sqlTime(172_800), updatedAt: sqlTime(172_800),
  },
  "note-travel": {
    id: "note-travel", userId: "u1", notebookId: "nb-travel", title: "十月旅行计划",
    content: "# 十月旅行计划\n\n待定。", contentText: "十月旅行计划 待定",
    contentFormat: "markdown", isPinned: 0, isFavorite: 0, isLocked: 0, isTrashed: 0, version: 1,
    createdAt: sqlTime(259_200), updatedAt: sqlTime(259_200),
  },
};

// 一个 1x1 的 PNG，用来让图片真的能渲染出来（验证签名 URL 替换链路）
// 示例图（600x240 蓝色带白框）—— 从文件读，避免把 base64 塞进源码搞出转义问题。
// 它存在的意义：证明「签名 URL 替换 → 图片真的显示出来」，而不只是 img 标签存在。
const PNG_1PX = readFileSync(
  new URL("./fixtures/demo-image.png", import.meta.url).pathname,
);


// ---------- 待办 / 全局搜索 / 日记 的夹具 ----------

const TASKS = [
  { id: "t1", userId: "u1", noteId: null, title: "给 Lite 加液态玻璃", content: "", status: "doing",
    priority: "high", dueDate: sqlTime(-86400), completedAt: null,
    sortOrder: 0, createdAt: "", updatedAt: "" },
  { id: "t2", userId: "u1", noteId: null, title: "跟维护者提 SDK 的三个 bug", content: "", status: "todo",
    priority: "medium", dueDate: null, completedAt: null, sortOrder: 1, createdAt: "", updatedAt: "" },
  { id: "t3", userId: "u1", noteId: null, title: "（已过期）处理 #798 的 PR", content: "", status: "todo",
    priority: "high", dueDate: sqlTime(3 * 86400), completedAt: null,
    sortOrder: 2, createdAt: "", updatedAt: "" },
  { id: "t4", userId: "u1", noteId: null, title: "已完成的任务", content: "", status: "done",
    priority: "low", dueDate: null, completedAt: sqlTime(0), sortOrder: 3, createdAt: "", updatedAt: "" },
];

// 图片 id 用固定值，配合 /api/diary/attachments/<id> 返回示例图
const IMG_A = "aaaa1111-2222-3333-4444-555555555555";
const IMG_B = "bbbb1111-2222-3333-4444-555555555555";
const IMG_C = "cccc1111-2222-3333-4444-555555555555";
const IMG_D = "dddd1111-2222-3333-4444-555555555555";

/** 已上传但尚未绑定到说说上的「悬空」附件 */
const UPLOADED_ATTACHMENTS = new Set();
/** 已被删除的附件 —— 让 GET 返回 404，用来验证「点 × 真删了」 */
const DELETED_ATTACHMENTS = new Set();

/**
 * 生成与**真实服务端完全一致**的时间字符串。
 *
 * ⚠️ 真实服务端返回的是裸 UTC：`"2026-10-07 08:31:30"`，**不带 Z、不带 T**。
 *    mock 早期用 `toISOString()`（带 Z），客户端不补 Z 也能解析对 —— 于是
 *    「笔记时间偏 8 小时」这个 bug 在测试里完全看不见，一上真机就露。
 *    mock 必须逐字复刻真实格式，否则它验证的是 mock 自己而不是产品。
 *
 * @param secondsAgo 距今多少秒（负数表示未来）
 */
function sqlTime(secondsAgo) {
  const d = new Date(Date.now() - secondsAgo * 1000);
  const p = (x) => String(x).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
  );
}

/**
 * 日期**相对今天**生成，不写死。
 * 写死的话（原来是 2026-10-07）测试跑久了就会从「今天/昨天/前天」退化成绝对日期，
 * 断言随日期变脆。相对生成后标签永远可预期。
 *
 * 格式化用 UTC —— 服务端存的也是 UTC，前端会按本地时区解析；
 * 减整数天在固定偏移的时区里必然落到「前 n 天的本地日期」。
 */
function daysAgoAt(n) {
  const d = new Date(Date.now() - n * 86_400_000);
  const p = (x) => String(x).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
  );
}

const DIARIES = [
  { id: "d1", contentText: "把 Lite 的底部导航做成了悬浮胶囊，滑动手感比原来好很多。", mood: "😀",
    createdAt: daysAgoAt(0), images: [], media: [
      { id: IMG_A, type: "image" }, { id: IMG_B, type: "image" }, { id: IMG_C, type: "image" },
      { id: IMG_D, type: "image" },
    ] },
  { id: "d2", contentText: "今天发现 @nowen/sdk 在浏览器里根本无法工作 ——\n全局 fetch 没绑定 this，直接 Illegal invocation。", mood: "😕",
    createdAt: daysAgoAt(1) },
  { id: "d3", contentText: "首屏体积压到 76KB，比主 App 小 21 倍。", mood: "🔥",
    createdAt: daysAgoAt(2) },
];

// ---------- 路由 ----------

function json(res, status, body) {
  const payload = JSON.stringify(body);
  if (status >= 400) console.log(`[mock]   ↳ ${status} ${res.req?.method || ""} ${res.req?.url || ""}`);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

/** 模拟服务端的 contentText 派生（真实实现见 backend extractSearchableText） */
function deriveContentText(content, format) {
  if (!content) return "";
  let text = content;
  if (format === "html") text = text.replace(/<[^>]*>/g, " ");
  else if (format === "markdown") text = text.replace(/[#*`>\-\[\]()!]/g, " ");
  else if (format === "tiptap-json") {
    try {
      const doc = JSON.parse(content);
      const walk = (n) => (n.text ? n.text : (n.content || []).map(walk).join(" "));
      text = walk(doc);
    } catch { text = ""; }
  }
  return text.replace(/\s+/g, " ").trim();
}

// ---------- 极简 JWT（只为让「15 分钟过期 + 续期」这条链路可测）----------
//   Lite 的 authedFetch 会本地解出 payload.exp 来判断「该续期了」，
//   所以 mock 必须签发【带真实 exp 的、三段式】token，否则测不到主动续期。
const b64url = (obj) =>
  Buffer.from(JSON.stringify(obj)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function makeJwt(sub, ttlSeconds, typ) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url({ alg: "none", typ: "JWT" });
  const payload = b64url({ sub, typ, iat: now, exp: now + ttlSeconds });
  return `${header}.${payload}.mocksig`;
}

function decodeJwt(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return null;
  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), "=");
    return JSON.parse(Buffer.from(padded, "base64").toString("utf-8"));
  } catch {
    return null;
  }
}

/** 只认【签发过】的 token —— 这样测试才能伪造一个「本地看着没过期、服务端不认」的 token，
 *  从而确定性地覆盖「401 后被动续期并重放」这条路径。 */
const REFRESH_TOKENS = new Set();
const LOGIN_TOKENS = new Set();
function issueTokens(sub, ttlSeconds) {
  const token = makeJwt(sub, ttlSeconds, "login");
  const refreshToken = makeJwt(sub, 30 * 24 * 3600, "refresh");
  LOGIN_TOKENS.add(token);
  REFRESH_TOKENS.add(refreshToken);
  return { token, refreshToken };
}

const n0 = () => new Date().toISOString();

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const path = url.pathname;
  console.log(`[mock] ${req.method} ${path}${url.search}`);

  const auth = req.headers.authorization || "";
  const bearer = auth.replace(/^Bearer\s+/, "");
  const payload = decodeJwt(bearer);
  // 校验签名之外的唯一关键点：exp。过期一律 401 —— 这正是要测的路径。
  const ok =
    !!payload &&
    typeof payload.exp === "number" &&
    payload.exp > Math.floor(Date.now() / 1000) &&
    (payload.typ === "refresh" || LOGIN_TOKENS.has(bearer));
  res.req = req;
  const tag = (status) => (status >= 400 ? `  ↳ ${status}` : "");
  void tag;

  // ⚠️ 真实服务端返回的是 { user: {...} }，**不是** SDK 类型里写的 { valid, userId, username }。
  //    mock 必须照真实结构返回，否则「已登录却显示会话失效」这个 bug 测不出来。
  if (path === "/api/auth/verify" && req.method === "GET") {
    if (!ok) {
      return json(res, 401, { error: "Token 无效或已过期", code: "TOKEN_INVALID" });
    }
    return json(res, 200, {
      user: {
        id: payload.sub || "u1",
        username: "demo",
        displayName: "演示账号",
        email: null,
        avatarUrl: null,
        role: "user",
        isDemo: false,
        createdAt: "2026-01-01 00:00:00",
      },
    });
  }

  if (path === "/api/auth/login" && req.method === "POST") {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let body = {};
      try { body = JSON.parse(raw); } catch { /* ignore */ }
      // 用固定账号模拟两种分支，方便测 2FA 流程
      if (body.username === "twofa" && body.password === "twofa") {
        return json(res, 200, { requires2FA: true, ticket: "mock-ticket", username: "twofa" });
      }
      if (body.username === "demo" && body.password === "demo1234") {
        const t = issueTokens("u1", 3600);
        return json(res, 200, { ...t, user: { id: "u1", username: "demo" } });
      }
      // 专门用于测试「短命 token + 自动续期」：access token 只活 3 秒
      if (body.username === "shortlived" && body.password === "shortlived") {
        const t = issueTokens("u2", 3);
        return json(res, 200, { ...t, user: { id: "u2", username: "shortlived" } });
      }
      return json(res, 401, { error: "用户名或密码错误" });
    });
    return;
  }

  if (path === "/api/auth/2fa/verify" && req.method === "POST") {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let body = {};
      try { body = JSON.parse(raw); } catch { /* ignore */ }
      if (body.ticket === "mock-ticket" && body.code === "123456") {
        return json(res, 200, issueTokens("u1", 3600));
      }
      return json(res, 401, { error: "验证码不正确" });
    });
    return;
  }

  if (path === "/api/auth/verify") {
    return ok
      ? json(res, 200, { valid: true, userId: payload.sub, username: "demo" })
      : json(res, 401, { error: "未认证" });
  }

  // 附件：必须放在鉴权检查【之前】。
  //   <img> 发请求带不了 Authorization 头 —— 真实服务端也是靠 URL 里的 exp/sig 鉴权。
  //   没带 sig 就 401，这样测试才能证明「签名 URL 替换」真的起了作用。
  const attMatch = path.match(/^\/api\/attachments\/([0-9a-f-]{36})$/i);
  if (attMatch) {
    if (!url.searchParams.get("sig")) return json(res, 401, { error: "缺少签名" });
    res.writeHead(200, { "Content-Type": "image/png", "Content-Length": PNG_1PX.length });
    return res.end(PNG_1PX);
  }

  // ---- 全局搜索（服务端 FTS）----
  if (path === "/api/auth/refresh" && req.method === "POST") {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let body = {};
      try { body = JSON.parse(raw); } catch { /* ignore */ }
      const p = decodeJwt(body.refreshToken);
      if (!p || p.typ !== "refresh" || !REFRESH_TOKENS.has(body.refreshToken) || p.exp <= Math.floor(Date.now() / 1000)) {
        return json(res, 401, { error: "登录已过期，请重新登录", code: "REFRESH_TOKEN_INVALID" });
      }
      // 轮换：旧 refresh token 作废（与真实服务端同口径）
      REFRESH_TOKENS.delete(body.refreshToken);
      return json(res, 200, issueTokens(p.sub, 3600));
    });
    return;
  }

  // 放行健康检查：测试脚本靠它确认「对面是 mock 而不是真实服务端」
  // 日记图片：真实服务端【不要 Authorization】（<img> 带不了 header）
  // ⚠️ 必须限定 GET：否则 DELETE /api/diary/attachments/<id> 会被这里截胡，
  //    返回一张图片（200）而不是执行删除 —— 表现为「点 × 删不掉，但界面看着删了」。
  const diaryImg = path.match(/^\/api\/diary\/attachments\/([0-9a-f-]{36})$/i);
  if (diaryImg && (req.method === "GET" || req.method === "HEAD")) {
    // 被删掉的悬空附件返回 404 —— 测试靠它确认「点 × 是真删了」而不是只从界面移除
    if (DELETED_ATTACHMENTS.has(diaryImg[1])) return json(res, 404, { error: "附件不存在" });
    res.writeHead(200, { "Content-Type": "image/png", "Content-Length": PNG_1PX.length });
    return res.end(PNG_1PX);
  }

  if (path === "/api/health") {
    return json(res, 200, { status: "ok", service: "nowen-lite-mock", version: "mock" });
  }

  if (!ok) return json(res, 401, { error: "未认证" });

  if (path === "/api/search") {
    const q = (url.searchParams.get("q") || "").trim().toLowerCase();
    const hits = Object.values(NOTES)
      .filter((n) => q && (n.title.toLowerCase().includes(q) || (n.contentText || "").toLowerCase().includes(q)))
      .map((n) => ({
        resourceType: "note",
        id: n.id,
        title: n.title,
        snippet: n.contentText,
        notebookId: n.notebookId,
        updatedAt: n.updatedAt,
      }));
    // 附带一条思维导图结果，用来验证「非笔记结果会被过滤并提示」
    if (q && "架构".includes(q[0])) {
      hits.push({ resourceType: "mindmap", id: "m1", title: "架构草图", snippet: "mindmap", notebookId: "nb-tech", updatedAt: n0() });
    }
    return json(res, 200, hits);
  }

  // ---- 待办 ----
  if (path === "/api/tasks/stats/summary") {
    const done = TASKS.filter((t) => t.status === "done").length;
    const overdue = TASKS.filter(
      (t) => t.status !== "done" && t.dueDate && new Date(t.dueDate).getTime() < Date.now(),
    ).length;
    return json(res, 200, {
      total: TASKS.length, completed: done, pending: TASKS.length - done,
      today: 0, overdue, week: 0,
    });
  }
  if (path === "/api/tasks" && req.method === "GET") return json(res, 200, TASKS);

  const taskToggle = path.match(/^\/api\/tasks\/([^/]+)\/toggle$/);
  if (taskToggle && req.method === "PATCH") {
    const t = TASKS.find((x) => x.id === taskToggle[1]);
    if (!t) return json(res, 404, { error: "任务不存在" });
    t.status = t.status === "done" ? "todo" : "done";
    t.completedAt = t.status === "done" ? new Date().toISOString() : null;
    return json(res, 200, t);
  }

  // ---- 日记 ----
  if (path === "/api/diary/timeline") {
    const limit = Number(url.searchParams.get("limit") || 20);
    const cursor = url.searchParams.get("cursor");
    let start = 0;
    if (cursor) {
      const idx = DIARIES.findIndex((d) => d.createdAt === cursor);
      start = idx >= 0 ? idx + 1 : 0;
    }
    const slice = DIARIES.slice(start, start + limit);
    const hasMore = start + limit < DIARIES.length;
    return json(res, 200, {
      items: slice,
      hasMore,
      nextCursor: hasMore ? slice[slice.length - 1].createdAt : null,
    });
  }
  // ---- 说说附件：上传（multipart）/ 删除悬空附件 ----
  //  真实契约见 backend/src/routes/diary.ts：字段名是 file，
  //  返回 {id,url,mimeType,size,filename,type}；上传后是 diaryId=NULL 的「悬空」状态。
  if (path === "/api/diary/attachments" && req.method === "POST") {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      // 只做够用的 multipart 解析（文件名 + MIME）。
      // 图片字节不需要 —— 缩略图统一回上面那个 1px fixture，够验证 <img> 真加载了。
      const head = raw.subarray(0, 2048).toString("latin1");
      const fn = /filename="([^"]*)"/.exec(head);
      const ct = /Content-Type:\s*([\w/.+-]+)/i.exec(head);
      const mime = (ct?.[1] || "image/png").toLowerCase();
      if (!mime.startsWith("image/") && !mime.startsWith("video/")) {
        return json(res, 415, { error: `不支持的 MIME 类型: ${mime}` });
      }
      const id = randomUUID();
      UPLOADED_ATTACHMENTS.add(id);
      return json(res, 201, {
        id,
        url: `/api/diary/attachments/${id}`,
        mimeType: mime,
        size: raw.length,
        filename: fn?.[1] || `${id}.png`,
        type: mime.startsWith("video/") ? "video" : "image",
      });
    });
    return;
  }

  const attachDel = path.match(/^\/api\/diary\/attachments\/([0-9a-f-]{36})$/i);
  if (attachDel && req.method === "DELETE") {
    if (!UPLOADED_ATTACHMENTS.has(attachDel[1])) return json(res, 404, { error: "附件不存在" });
    UPLOADED_ATTACHMENTS.delete(attachDel[1]);
    DELETED_ATTACHMENTS.add(attachDel[1]);
    res.writeHead(204);
    return res.end();
  }

  // ⚠️ 路径必须与真实服务端**逐字一致**：真实注册的是 POST /api/diary（无尾斜杠），
      //    带尾斜杠会 404。mock 曾经"两种都收"，结果把客户端的尾斜杠 bug 养了过去 ——
      //    所以这里刻意保持严格：带斜杠让它照样 404，测试才拦得住。
      if (path === "/api/diary/" && req.method === "POST") {
        return json(res, 404, { error: "Not Found" });
      }

      if (path === "/api/diary" && req.method === "POST") {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let body = {};
      try { body = JSON.parse(raw); } catch { /* ignore */ }
      // 真实服务端允许「纯图片说说」：文案与媒体至少一项非空
      const media = Array.isArray(body.media)
        ? body.media.filter((m) => m && typeof m.id === "string")
        : [];
      // 提交后这些附件就不再悬空了
      for (const m of media) UPLOADED_ATTACHMENTS.delete(m.id);
      if ((!body.contentText || !String(body.contentText).trim()) && media.length === 0) {
        return json(res, 400, { error: "内容不能为空" });
      }
      const now = new Date();
      const pad = (n) => String(n).padStart(2, "0");
      const createdAt =
        `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())} ` +
        `${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}:${pad(now.getUTCSeconds())}`;
      const item = {
        id: `d${DIARIES.length + 1}`,
        contentText: String(body.contentText || ""),
        mood: body.mood || "",
        media,
        createdAt,
      };
      DIARIES.unshift(item);
      return json(res, 200, item);
    });
    return;
  }

      // ---- PUT /api/diary/:id（编辑）----
      // 语义与真实服务端一致：字段「未传」= 保持不变，「显式传空」= 覆盖；
      // 校验合并后的 text 与 media 至少有一样非空。
      const diaryPut = /^\/api\/diary\/([^/]+)$/.exec(path);
      if (diaryPut && req.method === "PUT") {
        const target = DIARIES.find((d) => d.id === decodeURIComponent(diaryPut[1]));
        if (!target) return json(res, 404, { error: "Not found" });
        let raw = "";
        req.on("data", (c) => (raw += c));
        req.on("end", () => {
          let body = {};
          try { body = JSON.parse(raw); } catch { /* ignore */ }
          const nextText =
            typeof body.contentText === "string" ? body.contentText.trim() : undefined;
          const nextMood = typeof body.mood === "string" ? body.mood : undefined;
          const mediaProvided = Array.isArray(body.media) || Array.isArray(body.images);
          const nextMedia = mediaProvided
            ? (body.media || []).filter((m) => m && typeof m.id === "string")
            : undefined;

          const finalText = nextText !== undefined ? nextText : target.contentText;
          const finalMedia = nextMedia !== undefined
            ? nextMedia
            : (target.media || (target.images || []).map((id) => ({ id, type: "image" })));
          if (!finalText && finalMedia.length === 0) {
            return json(res, 400, { error: "Content or media required" });
          }
          if (nextText !== undefined) target.contentText = nextText;
          if (nextMood !== undefined) target.mood = nextMood;
          if (nextMedia !== undefined) target.media = nextMedia;
          // 提交后这些附件不再悬空
          for (const m of finalMedia) UPLOADED_ATTACHMENTS.delete(m.id);
          return json(res, 200, target);
        });
        return;
      }

      // ---- DELETE /api/diary/:id（删除）----
      if (diaryPut && req.method === "DELETE") {
        const idx = DIARIES.findIndex((d) => d.id === decodeURIComponent(diaryPut[1]));
        if (idx < 0) return json(res, 404, { error: "Not found" });
        DIARIES.splice(idx, 1);
        return json(res, 200, { success: true });
      }


  if (path === "/api/notebooks") return json(res, 200, NOTEBOOKS);

  if (path === "/api/notes" && req.method === "GET") {
    const notebookId = url.searchParams.get("notebookId");
    const list = Object.values(NOTES)
      .filter((n) => !notebookId || n.notebookId === notebookId)
      .map(({ content, ...rest }) => rest);
    return json(res, 200, list);
  }

  // ---- 新建笔记 ----
  if (path === "/api/notes" && req.method === "POST") {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let body = {};
      try { body = JSON.parse(raw); } catch { /* ignore */ }
      if (!body.notebookId) return json(res, 400, { error: "缺少 notebookId" });
      const id = `note-new-${Object.keys(NOTES).length + 1}`;
      const note = {
        id, userId: "u1", notebookId: body.notebookId,
        title: body.title || "无标题",
        content: body.content || "",
        contentText: deriveContentText(body.content || "", body.contentFormat || "markdown"),
        contentFormat: body.contentFormat || "markdown",
        isPinned: 0, isFavorite: 0, isLocked: 0, isTrashed: 0, version: 1,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      };
      NOTES[id] = note;
      return json(res, 200, note);
    });
    return;
  }

  // ---- 新建待办 ----
  if (path === "/api/tasks" && req.method === "POST") {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let body = {};
      try { body = JSON.parse(raw); } catch { /* ignore */ }
      if (!body.title || !String(body.title).trim()) return json(res, 400, { error: "标题不能为空" });
      const task = {
        id: `t${TASKS.length + 1}`, userId: "u1", noteId: null, title: String(body.title),
        content: body.content || "", status: body.status || "todo", priority: body.priority || "medium",
        dueDate: body.dueDate || null, completedAt: null, sortOrder: TASKS.length,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      };
      TASKS.unshift(task);
      return json(res, 200, task);
    });
    return;
  }

  const noteMatch = path.match(/^\/api\/notes\/([^/]+)$/);
  if (noteMatch && req.method === "GET") {
    const note = NOTES[noteMatch[1]];
    return note ? json(res, 200, note) : json(res, 404, { error: "笔记不存在" });
  }

  // PUT 带乐观锁 —— 必须与真实服务端行为一致，否则测不出冲突分支
  if (noteMatch && req.method === "PUT") {
    const note = NOTES[noteMatch[1]];
    if (!note) return json(res, 404, { error: "笔记不存在" });

    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let body = {};
      try { body = JSON.parse(raw); } catch { /* ignore */ }

      if (body.version === undefined) {
        return json(res, 400, { error: "缺少 version 字段，无法安全保存", code: "VERSION_REQUIRED" });
      }
      if (body.version !== note.version) {
        // 与真实服务端一致：409 + currentVersion
        return json(res, 409, {
          error: "Version conflict",
          code: "VERSION_CONFLICT",
          currentVersion: note.version,
        });
      }

      if (typeof body.title === "string") note.title = body.title;
      if (typeof body.content === "string") note.content = body.content;
      if (typeof body.contentFormat === "string") note.contentFormat = body.contentFormat;
      // 服务端会从 content 派生 contentText 并忽略客户端提交值
      note.contentText = deriveContentText(note.content, note.contentFormat);
      note.version += 1;
      note.updatedAt = new Date().toISOString();
      return json(res, 200, note);
    });
    return;
  }

  if (path === "/api/attachments/access/urls") {
    const noteId = url.searchParams.get("noteId");
    const id = "11111111-2222-3333-4444-555555555555";
    return json(res, 200, {
      urls: noteId ? { [id]: `/api/attachments/${id}?exp=9999999999&sig=mock` } : {},
    });
  }

  return json(res, 404, { error: `mock 未实现: ${path}` });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[mock] Nowen Mock API 已启动: http://127.0.0.1:${PORT}`);
  console.log("[mock] 可用账号： demo / demo1234   （2FA 分支： twofa / twofa + 验证码 123456）");
});
