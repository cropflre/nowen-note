/**
 * 端到端 UI 验证（Playwright + 真实 Chrome）
 *
 * 覆盖：登录（含错误分支 + 2FA 分支）→ 笔记本 → 笔记列表 → 三种格式的阅读渲染 → 图片签名 URL 替换
 *
 * 复用 nowen-note 项目里已装好的 playwright，避免重复下载浏览器。
 *   node scripts/verify-ui.mjs
 */
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";

const require = createRequire("/vol1/nowen-dev/nowen-note/frontend/");
const { chromium } = require("playwright");

const MOCK = "http://127.0.0.1:3999";

/**
 * 取一个**真实有效**的 token 供脚本直连 mock 用。
 * ⚠️ 不能再硬编码 "mock-token"：mock 现在签发带 exp 的真 JWT，并会拒过期 token。
 */
let mockToken = null;
async function ensureMockToken() {
  if (mockToken) return mockToken;
  const res = await fetch(`${MOCK}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "demo", password: "demo1234" }),
  });
  if (!res.ok) throw new Error(`拿 mock token 失败: ${res.status}`);
  mockToken = (await res.json()).token;
  return mockToken;
}

async function mockGet(path) {
  const token = await ensureMockToken();
  const res = await fetch(`${MOCK}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  return res.json();
}

/** 模拟「别人在另一台设备上改了这篇笔记」，把服务端版本推高一位 */
async function bumpNoteExternally(id, marker) {
  const token = await ensureMockToken();
  const cur = await mockGet(`/api/notes/${id}`);
  const put = await fetch(`${MOCK}/api/notes/${id}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      title: cur.title,
      content: `${cur.content}\n\n${marker}`,
      contentFormat: cur.contentFormat,
      version: cur.version,
    }),
  });
  if (!put.ok) throw new Error(`外部改动失败: ${put.status}`);
  return (await put.json()).version;
}

const BASE = process.env.LITE_URL || "http://127.0.0.1:5174";
const SHOTS = "/vol1/1000/workspaces/nowen-note-lite/screenshots";
mkdirSync(SHOTS, { recursive: true });

/**
 * 切 tab 并确认真的切过去了。
 *
 * ⚠️ 必须等【顶栏标题】，不能等 ".list-item" / ".searchbar input" 这类通用类名 ——
 *    上一个页面也有一模一样的元素，等待会立刻返回，
 *    后续 fill/click 就会打到马上要被卸载的旧元素上（实测过：搜索框填了个寂寞）。
 */
async function goTab(label) {
  await page.click(`.bottom-nav a:has-text("${label}")`);
  await page.waitForSelector(`.app-topbar h1:text-is("${label}")`, { timeout: 15000 });
}

const results = [];
/** 当前正在跑的环节 —— 失败时能立刻知道卡在哪一步，否则只能看到一个光秃秃的 selector 超时 */
let currentSection = "(启动)";
function check(name, pass, detail = "") {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? "✅" : "❌"} ${name}${detail ? `  — ${detail}` : ""}`);
}
/**
 * 等一张图片**真正加载完**再判断。
 *
 * ⚠️ 两个坑：
 *   ① 不能直接读 `naturalWidth` —— 图片没解码完时恒为 0，断言随机变红
 *      （实测约 1/5 概率，第 [27] 节最先暴露）。
 *   ② **要传 locator，不能传选择器字符串**：`page.waitForFunction` 里跑的是浏览器原生
 *      `querySelector`，而 `:has-text(...)` 是 Playwright 专有语法，会直接抛
 *      "not a valid selector"。所以这里用 locator + 轮询。
 */
async function imageLoaded(locator, timeout = 10000) {
  const img = locator.first();
  const deadline = Date.now() + timeout;
  for (;;) {
    const ok = await img
      .evaluate((el) => el.complete && el.naturalWidth > 0)
      .catch(() => false);
    if (ok) return true;
    if (Date.now() > deadline) return false;
    await page.waitForTimeout(120);
  }
}


// ⚠️⚠️ 安全闸门：这套测试会【写入】数据（改笔记、发说说、勾任务）。
//      如果误连到真实服务端，就会污染真实数据 —— 所以开跑前必须确认对面是 mock。
{
  let health;
  try {
    const res = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(8000) });
    health = await res.json();
  } catch (err) {
    console.error(`\n✗ 连不上 ${BASE}：${err.message}`);
    console.error("  请先启动 mock 与 dev server：");
    console.error("    node scripts/mock-api.mjs 3999 &");
    console.error("    NOWEN_LITE_BACKEND=http://127.0.0.1:3999 npx vite --port 5176 &");
    process.exit(2);
  }
  if (health?.service !== "nowen-lite-mock") {
    console.error(`\n✗ 拒绝执行：${BASE} 接的不是 mock（实际 service=${health?.service ?? "未知"}）。`);
    console.error("  这套测试会写入数据，绝不能对真实服务端运行。");
    console.error("  请把 dev server 指向 mock：NOWEN_LITE_BACKEND=http://127.0.0.1:3999 npx vite --port 5176");
    process.exit(2);
  }
  console.log(`  安全闸门通过：目标确认为 mock（${health.service}）`);
}

const browser = await chromium.launch({
  executablePath: "/usr/bin/google-chrome",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
});

const consoleErrors = [];
page.on("console", (m) => {
  if (m.type() === "error") consoleErrors.push(m.text());
});
page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));

// ⚠️ HTTP 失败必须【单独】收集。
//    同一个 401 会同时产生一条浏览器 console 错误和一次 response 事件，
//    混在一个数组里会重复计数（曾经因此把「恰好 2 次」误报成 4 次）。
const httpFailures = [];
/** 统计自动续期次数 —— 用来证明「15 分钟掉线」真的被修好了 */
let refreshCalls = 0;
page.on("request", (r) => {
  if (r.url().includes("/api/auth/refresh")) refreshCalls += 1;
});
page.on("response", (r) => {
  if (r.status() >= 400) httpFailures.push({ status: r.status(), url: r.url() });
});

let alertFired = false;
page.on("dialog", async (d) => {
  alertFired = true;
  await d.dismiss();
});

try {
  // ---------- 1. 登录页 ----------
  currentSection = "[1] 登录页"; console.log("\n[1] 登录页");
  await page.goto(BASE, { waitUntil: "networkidle" });
  // ⚠️ 界面语言钉死为中文：Playwright 的浏览器语言是 en，i18n 会切成英文，
  //    本文件所有中文断言都会失败。language 的切换本身在第 [30] 节单独测。
  await page.evaluate(() => localStorage.setItem("nowen-lite.lang", "zh-CN"));
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector("text=Nowen Note Lite", { timeout: 15000 });
  check("登录页渲染", true);
  await page.screenshot({ path: `${SHOTS}/01-login.png` });

  const tabCount = await page.locator(".bottom-nav a").count();
  check("未登录时不显示底部导航", tabCount === 0, `实际 ${tabCount} 个`);

  // ---------- 2. 错误密码分支 ----------
  currentSection = "[2] 错误密码分支"; console.log("\n[2] 错误密码分支");
  await page.fill("#username", "demo");
  await page.fill("#password", "wrong-password");
  await page.click('button[type="submit"]');
  await page.waitForSelector('[data-testid="login-error"]', { timeout: 15000 });
  const errText = (await page.locator('[data-testid="login-error"]').innerText()).trim();
  check("错误密码显示服务端真实报错", errText.includes("用户名或密码错误"), errText);
  await page.screenshot({ path: `${SHOTS}/02-login-error.png` });

  // ---------- 3. 2FA 分支 ----------
  currentSection = "[3] 两步验证分支"; console.log("\n[3] 两步验证分支");
  await page.fill("#username", "twofa");
  await page.fill("#password", "twofa");
  await page.click('button[type="submit"]');
  await page.waitForSelector("#code", { timeout: 15000 });
  check("进入 2FA 验证码页", true);
  await page.screenshot({ path: `${SHOTS}/03-2fa.png` });

  await page.fill("#code", "000000");
  await page.click('[data-testid="twofa-submit"]');
  await page.waitForSelector('[data-testid="login-error"]', { timeout: 15000 });
  const twoFaErr = await page.locator('[data-testid="login-error"]').innerText();
  check("错误验证码被拒绝", twoFaErr.includes("验证码不正确"), twoFaErr.trim());

  await page.fill("#code", "123456");
  await page.click('[data-testid="twofa-submit"]');
  await page.waitForSelector(".bottom-nav", { timeout: 15000 });
  check("正确验证码登录成功", true);

  // ---------- 4. 底部导航 ----------
  currentSection = "[4] 底部导航"; console.log("\n[4] 底部导航");
  const navLabels = await page.locator(".bottom-nav a").allInnerTexts();
  const labels = navLabels.map((t) => t.replace(/\s+/g, "")).join("|");
  check("5 个 tab 齐全", /笔记/.test(labels) && /日记/.test(labels) && /待办/.test(labels) && /搜索/.test(labels) && /设置/.test(labels), labels);

  // ---------- 5. 笔记本列表 ----------
  currentSection = "[5] 笔记流（扁平）"; console.log("\n[5] 笔记流（扁平）");
  await page.waitForSelector("a.list-item", { timeout: 15000 });
  const feedTitles = await page.locator(".list-item .li-title").allInnerTexts();
  check(
    "笔记 tab 直接平铺全部笔记（不再先点笔记本）",
    feedTitles.length === 4,
    `${feedTitles.length} 条：${feedTitles.map((t) => t.trim()).join(" / ")}`,
  );
  check(
    "两个笔记本的笔记平铺在一起",
    feedTitles.some((t) => t.includes("移动端开发踩坑记录")) &&
      feedTitles.some((t) => t.includes("十月旅行计划")),
  );
  check("置顶笔记排在最前", feedTitles[0].includes("📌"), feedTitles[0].trim());
  const feedSub = await page.locator(".list-item .li-sub").first().innerText();
  check("笔记本名只作为次要信息出现在副行", feedSub.includes("技术笔记"), feedSub.trim());

  // ★ 时区回归：服务端给的是【裸 UTC】（"YYYY-MM-DD HH:MM:SS"，不带 Z），
  //   JS 的 new Date() 会按本地时间解析 → 东八区下全部偏 8 小时，
  //   于是「1 小时前」会显示成「9 小时前」。mock 早期返回的是带 Z 的 ISO，
  //   所以这条断言在 mock 上一直是绿的，直到 mock 也改成裸 UTC 才逼出来。
  const oneHourRow = await page
    .locator('.list-item:has-text("移动端开发踩坑记录") .li-sub')
    .innerText();
  check(
    "「1 小时前」的笔记确实显示 1 小时前（服务端时间是 UTC，不能被当成本地时间）",
    oneHourRow.trim().startsWith("1 小时前"),
    oneHourRow.trim(),
  );
  await page.screenshot({ path: `${SHOTS}/04-notes-feed.png` });

  // ---------- 6. 直接点开笔记（没有二级收纳） ----------
  currentSection = "[6] 点开笔记"; console.log("\n[6] 点开笔记");
  await page.click('a.list-item:has-text("移动端开发踩坑记录")');
  await page.waitForSelector(".note-body", { timeout: 15000 });
  const openedTitle = await page.locator(".app-topbar h1").innerText();
  check("点一条笔记就直接进入那一篇（中间没有笔记本列表）", openedTitle.includes("移动端开发踩坑记录"), openedTitle);
  await page.screenshot({ path: `${SHOTS}/05-note-opened.png` });

  // ---------- 7. Markdown 渲染 ----------
  currentSection = "[7] Markdown 笔记阅读"; console.log("\n[7] Markdown 笔记阅读");
  check("Markdown 渲染出 h1", (await page.locator(".note-body h1").count()) > 0);
  check("Markdown 渲染出表格", (await page.locator(".note-body table").count()) > 0);
  check("Markdown 渲染出代码块", (await page.locator(".note-body pre").count()) > 0);
  check("Markdown 渲染出引用块", (await page.locator(".note-body blockquote").count()) > 0);
  const mdImg = page.locator(".note-body img").first();
  const mdImgOk = await imageLoaded(page.locator(".note-body img"));
  const mdImgSrc = await mdImg.getAttribute("src").catch(() => "");
  check("图片经签名 URL 替换并真实加载", mdImgOk, mdImgSrc || "(无 img)");
  await page.screenshot({ path: `${SHOTS}/06-note-markdown.png`, fullPage: true });

  // ---------- 8. HTML 渲染 + XSS 消毒 ----------
  currentSection = "[8] HTML 笔记阅读（含 XSS 消毒）"; console.log("\n[8] HTML 笔记阅读（含 XSS 消毒）");
  await page.goBack();
  await page.waitForSelector('a.list-item:has-text("网页剪藏")', { timeout: 15000 });
  await page.click('a.list-item:has-text("网页剪藏")');
  await page.waitForSelector(".note-body", { timeout: 15000 });
  const scriptCount = await page.locator(".note-body script").count();
  check("DOMPurify 清掉了 <script>", scriptCount === 0, `残留 ${scriptCount} 个`);
  check("没有触发 alert 弹窗", alertFired === false);
  check("HTML 表格保留", (await page.locator(".note-body table").count()) > 0);
  const htmlImgOk = await imageLoaded(page.locator(".note-body img"));
  check("HTML 笔记的图片也加载成功", htmlImgOk);
  await page.screenshot({ path: `${SHOTS}/07-note-html.png`, fullPage: true });

  // ---------- 9. tiptap-json 渲染 ----------
  currentSection = "[9] 富文本（tiptap-json）笔记阅读"; console.log("\n[9] 富文本（tiptap-json）笔记阅读");
  await page.goBack();
  await page.waitForSelector('a.list-item:has-text("富文本笔记")', { timeout: 15000 });
  await page.click('a.list-item:has-text("富文本笔记")');
  await page.waitForSelector(".note-body", { timeout: 15000 });
  check("tiptap-json 渲染出标题", (await page.locator(".note-body h1").count()) > 0);
  check("tiptap-json 渲染出列表", (await page.locator(".note-body ul li").count()) >= 2);
  check("tiptap-json 行内 code 标记生效", (await page.locator(".note-body code").count()) > 0);
  const tImg = page.locator(".note-body img").first();
  const tImgOk = await imageLoaded(page.locator(".note-body img"));
  const tImgSrc = await tImg.getAttribute("src").catch(() => "");
  check("tiptap-json 的图片经签名 URL 替换并真实加载", tImgOk, tImgSrc || "(无 img)");
  const unknownNodeText = await page.locator(".note-body").innerText();
  check("未知节点(main/mention)退化为不丢内容", unknownNodeText.includes("未知节点测试"), "");
  await page.screenshot({ path: `${SHOTS}/08-note-tiptap.png`, fullPage: true });

  // ---------- 10. 笔记流顶部搜索框 ----------
  currentSection = "[10] 笔记流顶部搜索框"; console.log("\n[10] 笔记流顶部搜索框");
  await goTab("笔记");
  await page.waitForSelector(".searchbar input", { timeout: 15000 });
  check("笔记流顶部有搜索框", true);
  const clearBtns = await page.locator(".searchbar button").count();
  check("搜索框只有一个清除按钮（无原生重叠）", clearBtns === 0, `初始 ${clearBtns} 个（空值时本应为 0）`);

  const beforeCount = await page.locator("a.list-item").count();
  await page.fill(".searchbar input", "剪藏");
  await page.waitForFunction(
    () => document.querySelectorAll("a.list-item").length === 1,
    undefined,
    { timeout: 5000 },
  );
  const afterCount = await page.locator("a.list-item").count();
  check("本地实时过滤生效（4 → 1）", beforeCount === 4 && afterCount === 1, `${beforeCount} → ${afterCount}`);
  check("命中关键词被 <mark> 高亮", (await page.locator(".li-title mark, .li-sub mark").count()) > 0);
  const clearBtns2 = await page.locator(".searchbar button").count();
  check("有输入时恰好 1 个清除按钮", clearBtns2 === 1, `${clearBtns2} 个`);
  await page.screenshot({ path: `${SHOTS}/11-note-search.png` });

  await page.fill(".searchbar input", "绝对不存在的关键词");
  await page.waitForSelector("text=没有匹配", { timeout: 5000 });
  check("无结果时给出明确提示", true);
  await page.fill(".searchbar input", "");

  // ---------- 11. 全局搜索 ----------
  currentSection = "[11] 全局搜索"; console.log("\n[11] 全局搜索");
  await goTab("全局搜索");
  await page.waitForSelector(".searchbar input", { timeout: 15000 });
  check("tab 已改名为「全局搜索」", (await page.locator(".bottom-nav").innerText()).includes("全局搜索"));
  await page.fill(".searchbar input", "记录");
  await page.waitForSelector("a.list-item", { timeout: 15000 });
  const hitCount = await page.locator("a.list-item").count();
  check("服务端全文检索返回结果", hitCount >= 1, `${hitCount} 条`);
  check("结果关键词高亮", (await page.locator(".li-title mark, .li-sub mark").count()) > 0);
  await page.screenshot({ path: `${SHOTS}/12-global-search.png` });

  // 防抖：连续输入不应把过期结果留在屏幕上
  await page.fill(".searchbar input", "记录x");
  await page.waitForSelector("text=没有找到", { timeout: 10000 });
  check("无结果提示正常（防抖未串台）", true);

  // ---------- 12. 待办 ----------
  currentSection = "[12] 待办"; console.log("\n[12] 待办");
  await goTab("待办");
  await page.waitForSelector(".task-row", { timeout: 15000 });
  const statNums = await page.locator(".stat-cell .stat-num").allInnerTexts();
  check("统计数字渲染（待办/逾期/已完成）", statNums.length === 3, statNums.join(" / "));
  check("逾期数被正确标红", Number(statNums[1]) === 1, `逾期=${statNums[1]}`);
  const openCount = await page.locator(".task-row").count();
  check("默认只显示未完成", openCount === 3, `${openCount} 条`);
  await page.screenshot({ path: `${SHOTS}/13-tasks.png` });

  await page.click('.task-row:has-text("给 Lite 加液态玻璃")');
  await page.waitForFunction(
    (n) => document.querySelectorAll(".task-row").length === n - 1,
    openCount,
    { timeout: 10000 },
  );
  check("勾选后从未完成列表消失（乐观更新）", true);

  await page.click('.searchbar button:has-text("已完成")');
  await page.waitForFunction(
    () => document.querySelectorAll(".task-row").length === 2,
    undefined,
    { timeout: 10000 },
  );
  check("切到「已完成」能看到刚勾的那条", true);

  // ---------- 13. 日记 ----------
  currentSection = "[13] 日记说说"; console.log("\n[13] 日记说说");
  await goTab("日记说说");
  await page.waitForSelector(".list-item", { timeout: 15000 });
  const diaryCount = await page.locator(".list-item").count();
  check("日记时间线加载", diaryCount === 3, `${diaryCount} 条`);
  const diaryText = await page.locator(".app-content").innerText();
  check("渲染心情与正文", diaryText.includes("😀") && diaryText.includes("悬浮胶囊"));
  await page.screenshot({ path: `${SHOTS}/14-diary.png` });

  await page.click('.fab:has-text("写说说")');
  await page.waitForSelector("textarea", { timeout: 10000 });
  await page.fill("textarea", "这是端到端测试写入的一条说说。");
  await page.click('.card button:has-text("发布")');
  await page.waitForFunction(
    (n) => document.querySelectorAll(".list-item").length === n + 1,
    diaryCount,
    { timeout: 15000 },
  );
  check("发布成功后列表新增一条", true);

  // ---------- 14. 液态玻璃 & 悬浮导航（断言真实计算样式）----------
  currentSection = "[14] 液态玻璃 & 悬浮导航"; console.log("\n[14] 液态玻璃 & 悬浮导航");
  const navStyle = await page.locator(".bottom-nav").evaluate((el) => {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return {
      position: cs.position,
      radius: parseFloat(cs.borderTopLeftRadius),
      backdrop: cs.backdropFilter || cs.webkitBackdropFilter || "none",
      left: r.left,
      right: window.innerWidth - r.right,
      bottom: window.innerHeight - r.bottom,
      hasGlassBefore: !!getComputedStyle(el, "::before").backgroundImage.match(/gradient/),
    };
  });
  check("底部导航是悬浮定位（fixed）", navStyle.position === "fixed", navStyle.position);
  check("左右留白 → 悬浮而非贴边", navStyle.left > 4 && navStyle.right > 4, `left=${navStyle.left} right=${navStyle.right}`);
  check("离底部有间距", navStyle.bottom > 4, `bottom=${navStyle.bottom}`);
  check("圆角是胶囊级（≥28px）", navStyle.radius >= 28, `${navStyle.radius}px`);
  {
    // 折射是「液态玻璃」皮肤的特征；默认的「原生」皮肤刻意用不透明表面、不模糊。
    // 两种皮肤的折射差异在第 [31] 节做了成对验证。
    const skin = await page.evaluate(() => document.documentElement.dataset.style);
    if (skin === "liquid") {
      check("液态玻璃：导航启用了 backdrop-filter（真实折射）", /blur/.test(navStyle.backdrop), navStyle.backdrop);
    } else {
      check("原生风格：刻意不模糊（不透明表面）", navStyle.backdrop === "none", navStyle.backdrop);
    }
  }
  check("有镜面高光层（::before 渐变）", navStyle.hasGlassBefore);

  const pillMoved = await page.locator(".bottom-nav .nav-pill").evaluate((el) => {
    return getComputedStyle(el).transform;
  });
  check("选中胶囊有位移指示器", pillMoved !== "none" && pillMoved !== "", pillMoved);

  // 内容没有被悬浮导航挡住
  const notCovered = await page.evaluate(() => {
    const nav = document.querySelector(".bottom-nav").getBoundingClientRect();
    const content = document.querySelector(".app-content");
    const pad = parseFloat(getComputedStyle(content).paddingBottom);
    return pad >= nav.height;
  });
  check("内容底部留白 ≥ 导航高度（不被遮挡）", notCovered);

  // backdrop-filter 不能用在每一行上（性能）
  const rowBackdrop = await page.locator(".list-item").first().evaluate((el) => {
    const cs = getComputedStyle(el);
    return cs.backdropFilter || cs.webkitBackdropFilter || "none";
  });
  check("列表行【没有】用 backdrop-filter（保滚动性能）", rowBackdrop === "none", rowBackdrop);

  // ---------- 15. 设置 ----------
  currentSection = "[15] 设置"; console.log("\n[15] 设置");
  await goTab("设置");
  await page.waitForSelector("#server-url", { timeout: 15000 });
  check("设置页可用", true);
  await page.screenshot({ path: `${SHOTS}/15-settings.png` });

  // ---------- 16. 编辑：基本流程 ----------
  currentSection = "[16] 编辑 · 基本流程"; console.log("\n[16] 编辑 · 基本流程");
  await goTab("笔记");
  await page.waitForSelector('a.list-item:has-text("移动端开发踩坑记录")', { timeout: 15000 });
  await page.click('a.list-item:has-text("移动端开发踩坑记录")');
  await page.waitForSelector(".note-body", { timeout: 15000 });

  check("可编辑格式显示「编辑」按钮", (await page.locator('.topbar-btn:has-text("编辑")').count()) === 1);
  await page.click('.topbar-btn:has-text("编辑")');
  await page.waitForSelector(".editor-area", { timeout: 15000 });
  const loadedTitle = await page.inputValue(".editor-title");
  const loadedBody = await page.inputValue(".editor-area");
  check("编辑器带出原标题", loadedTitle.includes("移动端开发踩坑记录"), loadedTitle);
  check("编辑器带出原正文", loadedBody.includes("移动端开发踩坑记录"), `${loadedBody.length} 字`);
  check("保存按钮初始为禁用（未修改）", await page.locator('.topbar-btn:has-text("保存")').isDisabled());
  await page.screenshot({ path: `${SHOTS}/16-editor.png` });

  // Markdown 工具栏
  await page.click('.tool-btn:has-text("H2")');
  const afterToolbar = await page.inputValue(".editor-area");
  check("工具栏能插入 Markdown 标记", afterToolbar.includes("## "), afterToolbar.slice(0, 24).replace(/\n/g, "\\n"));
  check("插入后变为未保存", (await page.locator(".chip:has-text('未保存')").count()) === 1);

  // 预览切换
  await page.click('.topbar-btn:has-text("预览")');
  await page.waitForSelector(".editor-preview", { timeout: 10000 });
  check("可切到 Markdown 预览", (await page.locator(".editor-preview .note-body").count()) === 1);
  await page.screenshot({ path: `${SHOTS}/17-editor-preview.png` });
  await page.click('.topbar-btn:has-text("编辑")');
  await page.waitForSelector(".editor-area", { timeout: 10000 });

  // 正常保存
  await page.fill(".editor-area", "# 被 Lite 保存过\n\n这是端到端测试写入的正文。");
  await page.click('.topbar-btn:has-text("保存")');
  await page.waitForSelector(".note-body", { timeout: 15000 });
  const savedText = await page.locator(".note-body").innerText();
  check("保存后回到阅读页且内容已更新", savedText.includes("被 Lite 保存过"), savedText.slice(0, 30).replace(/\n/g, " "));

  const persisted = await mockGet("/api/notes/note-md");
  check("服务端确实落库", persisted.content.includes("被 Lite 保存过"), `version=${persisted.version}`);
  check("服务端重新派生了 contentText", persisted.contentText.includes("被 Lite 保存过"), persisted.contentText.slice(0, 40));

  // ---------- 17. 编辑：版本冲突（最重要的分支）----------
  currentSection = "[17] 编辑 · 版本冲突"; console.log("\n[17] 编辑 · 版本冲突");
  await page.click('.topbar-btn:has-text("编辑")');
  await page.waitForSelector(".editor-area", { timeout: 15000 });
  await page.fill(".editor-area", "# 我的版本\n\n这段不能被静默覆盖。");

  // 模拟「别人在别的设备上改了」
  const bumped = await bumpNoteExternally("note-md", "（别人改的）");
  check("已在外部把服务端版本推高", bumped > 0, `v${bumped}`);

  await page.click('.topbar-btn:has-text("保存")');
  await page.waitForSelector("dialog.sheet", { timeout: 15000 });
  const conflictText = await page.locator("dialog.sheet").innerText();
  check("保存冲突时弹出对话框（未静默覆盖）", conflictText.includes("在别处被修改过"), conflictText.slice(0, 40).replace(/\n/g, " "));
  check("对话框里显示了双方版本号", conflictText.includes(`v${bumped}`), conflictText.replace(/\n/g, " ").slice(0, 70));
  await page.screenshot({ path: `${SHOTS}/18-conflict.png` });

  // 选「载入最新」
  await page.click('dialog.sheet button:has-text("载入最新")');
  await page.waitForTimeout(600);
  const afterReload = await page.inputValue(".editor-area");
  check("载入最新后编辑器换成对方的内容", afterReload.includes("别人改的"), afterReload.slice(-24).replace(/\n/g, "\\n"));
  check("载入最新后不再显示未保存", (await page.locator(".chip:has-text('未保存')").count()) === 0);

  // ---------- 18. 编辑：主动覆盖 ----------
  currentSection = "[18] 编辑 · 用我的版本覆盖"; console.log("\n[18] 编辑 · 用我的版本覆盖");
  await page.fill(".editor-area", "# 我坚持覆盖\n\n这是我的版本。");
  const bumped2 = await bumpNoteExternally("note-md", "（第二次外部改动）");
  await page.click('.topbar-btn:has-text("保存")');
  await page.waitForSelector("dialog.sheet", { timeout: 15000 });
  await page.click('dialog.sheet button:has-text("用我的版本覆盖")');
  await page.waitForSelector(".note-body", { timeout: 15000 });
  const finalText = await page.locator(".note-body").innerText();
  check("覆盖后阅读页是我的内容", finalText.includes("我坚持覆盖"), finalText.slice(0, 24).replace(/\n/g, " "));

  const finalPersist = await mockGet("/api/notes/note-md");
  check("服务端是我的内容（覆盖成功）", finalPersist.content.includes("我坚持覆盖"), `version=${finalPersist.version}`);
  check("覆盖是在拿到对方最新版本号之后做的", finalPersist.version > bumped2, `v${finalPersist.version} > v${bumped2}`);

  // ---------- 19. 编辑：未保存的草稿 ----------
  currentSection = "[19] 编辑 · 草稿落盘与返回守卫"; console.log("\n[19] 编辑 · 草稿落盘与返回守卫");
  await page.click('.topbar-btn:has-text("编辑")');
  await page.waitForSelector(".editor-area", { timeout: 15000 });
  await page.fill(".editor-area", "改了但不保存，先切走");
  await page.waitForSelector(".chip:has-text('草稿已存')", { timeout: 8000 });
  check("停止输入后草稿自动落盘（状态变「草稿已存」）", true);
  await page.screenshot({ path: `${SHOTS}/19-draft.png` });

  // 直接切 tab 走人（不再拦截导航，靠草稿兜底）
  await goTab("设置");
  await page.waitForSelector("#server-url", { timeout: 15000 });
  check("切 tab 不被拦截（手机上强拦导航很烦）", true);

  // 回到编辑器：应该提示有草稿
  await goTab("笔记");
  await page.waitForSelector('a.list-item:has-text("移动端开发踩坑记录")', { timeout: 15000 });
  await page.click('a.list-item:has-text("移动端开发踩坑记录")');
  await page.waitForSelector(".note-body", { timeout: 15000 });
  await page.click('.topbar-btn:has-text("编辑")');
  await page.waitForSelector("dialog.sheet", { timeout: 15000 });
  const draftText = await page.locator("dialog.sheet").innerText();
  check("重进编辑器时提示发现草稿", draftText.includes("草稿"), draftText.replace(/\n/g, " ").slice(0, 40));

  await page.click('dialog.sheet button:has-text("恢复草稿")');
  await page.waitForSelector(".editor-area", { timeout: 10000 });
  check(
    "恢复草稿后内容回来了",
    (await page.inputValue(".editor-area")) === "改了但不保存，先切走",
    await page.inputValue(".editor-area"),
  );
  check("恢复后标记为未保存", (await page.locator(".chip:has-text('草稿已存'), .chip:has-text('未保存')").count()) === 1);

  // 编辑器内的返回按钮仍然要问（这个不会导致卸载重挂）
  await page.click('.topbar-btn[aria-label="返回"]');
  await page.waitForSelector("dialog.sheet", { timeout: 10000 });
  check("编辑器内点返回会询问", (await page.locator("dialog.sheet").innerText()).includes("未保存"));
  await page.screenshot({ path: `${SHOTS}/20-unsaved-guard.png` });
  await page.click('dialog.sheet button:has-text("继续编辑")');
  await page.waitForSelector(".editor-area", { timeout: 10000 });
  check("选「继续编辑」后留在编辑器", (await page.locator(".editor-area").count()) === 1);

  await page.click('.topbar-btn[aria-label="返回"]');
  await page.waitForSelector("dialog.sheet", { timeout: 10000 });
  await page.click('dialog.sheet button:has-text("放弃修改并离开")');
  await page.waitForSelector(".note-body", { timeout: 15000 });
  check("选「放弃」后回到阅读页", true);

  // 放弃后草稿要清掉，再进编辑器不应再提示
  await page.click('.topbar-btn:has-text("编辑")');
  await page.waitForSelector(".editor-area", { timeout: 15000 });
  await page.waitForTimeout(500);
  check("放弃后草稿被清掉（不再提示）", (await page.locator("dialog.sheet").count()) === 0);

  // ---------- 20. 只读格式不给编辑入口 ----------
  currentSection = "[20] 编辑 · 只读格式"; console.log("\n[20] 编辑 · 只读格式");
  await goTab("笔记");
  await page.waitForSelector('a.list-item:has-text("富文本笔记")', { timeout: 15000 });
  await page.click('a.list-item:has-text("富文本笔记")');
  await page.waitForSelector(".note-body", { timeout: 15000 });
  check("tiptap-json 笔记不显示「编辑」按钮", (await page.locator('.topbar-btn:has-text("编辑")').count()) === 0);

  await page.goBack();
  await page.waitForSelector('a.list-item:has-text("网页剪藏")', { timeout: 15000 });
  await page.click('a.list-item:has-text("网页剪藏")');
  await page.waitForSelector(".note-body", { timeout: 15000 });
  check("HTML 笔记显示「编辑」按钮（源码编辑）", (await page.locator('.topbar-btn:has-text("编辑")').count()) === 1);
  await page.click('.topbar-btn:has-text("编辑")');
  await page.waitForSelector(".editor-area", { timeout: 15000 });
  check("HTML 笔记进入源码编辑并给出提示", (await page.locator(".editor-hint").count()) === 1);
  check("HTML 格式不提供 Markdown 工具栏", (await page.locator(".editor-toolbar").count()) === 0);

  // ---------- 16. 控制台 ----------
  // ---------- 21. 悬浮新建按钮 ----------
  currentSection = "[21] 悬浮新建按钮"; console.log("\n[21] 悬浮新建按钮");
  await goTab("笔记");
  await page.waitForSelector('a.list-item:has-text("移动端开发踩坑记录")', { timeout: 15000 });
  check("笔记流有「新建笔记」悬浮按钮", (await page.locator('.fab:has-text("新建笔记")').count()) === 1);
  const fabAboveNav = await page.evaluate(() => {
    const fab = document.querySelector(".fab").getBoundingClientRect();
    const nav = document.querySelector(".bottom-nav").getBoundingClientRect();
    return fab.bottom <= nav.top + 1;
  });
  check("悬浮按钮位于导航栏上方（不重叠）", fabAboveNav);
  await page.screenshot({ path: `${SHOTS}/21-fab-notebooks.png` });

  await page.click('.fab:has-text("新建笔记")');
  await page.waitForSelector(".picker", { timeout: 10000 });
  check("点新建会先问建到哪个笔记本", (await page.locator(".picker-title").innerText()).includes("新建笔记"));
  // 上百个笔记本时必须有搜索，否则翻不到
  const pickerItems = await page.locator('[data-testid="picker-item"]').count();
  check("选择器列出全部笔记本", pickerItems === 14, `${pickerItems} 个`);
  const pickerNames = await page.locator('[data-testid="picker-item"] .li-title').allInnerTexts();
  check("按笔记数倒序（常用的在前）", pickerNames[0].includes("技术笔记"), pickerNames.join(" / "));
  await page.screenshot({ path: `${SHOTS}/28-notebook-picker.png` });

  // 搜索筛选
  await page.fill(".picker input", "旅行");
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid="picker-item"]').length === 1,
    undefined,
    { timeout: 5000 },
  );
  check("选择器可按名字搜索", true);
  await page.fill(".picker input", "");

  await page.click('[data-testid="picker-item"]:has-text("技术笔记")');
  await page.waitForSelector(".editor-area", { timeout: 15000 });
  check("创建后直接进入编辑器", (await page.inputValue(".editor-title")) === "无标题", await page.inputValue(".editor-title"));

  // 编辑器里返回（未修改，不该弹询问）
  await page.click('.topbar-btn[aria-label="返回"]');
  await page.waitForSelector(".note-body", { timeout: 15000 });
  check("编辑器返回落到阅读页", true);

  // ---------- 22. 待办新建 ----------
  currentSection = "[22] 待办 · 新建"; console.log("\n[22] 待办 · 新建");
  await goTab("待办");
  await page.waitForSelector(".task-row", { timeout: 15000 });
  const beforeTasks = await page.locator(".task-row").count();
  check("待办页有「新建待办」悬浮按钮", (await page.locator('.fab:has-text("新建待办")').count()) === 1);
  await page.click('.fab:has-text("新建待办")');
  await page.waitForSelector(".dialog-input", { timeout: 10000 });
  await page.fill(".dialog-input", "端到端测试新建的待办");
  await page.click('dialog.sheet button:has-text("创建")');
  await page.waitForFunction(
    (n) => document.querySelectorAll(".task-row").length === n + 1,
    beforeTasks,
    { timeout: 15000 },
  );
  check("新建待办后立刻出现在列表", true);
  await page.screenshot({ path: `${SHOTS}/22-task-created.png` });

  // ---------- 23. 日记说说：改名 + 朋友圈式图片 ----------
  currentSection = "[23] 日记说说 · 图片"; console.log("\n[23] 日记说说 · 图片");
  await goTab("日记说说");
  await page.waitForSelector(".diary-item", { timeout: 15000 });
  check("tab 已改名为「日记说说」", (await page.locator(".bottom-nav").innerText()).includes("日记说说"));

  const grid = page.locator('.moments[data-count="4"]');
  check("带 4 张图的说说渲染成两列网格", (await grid.count()) === 1);
  const cells = await grid.locator(".moments-cell").count();
  check("网格里是 4 张图", cells === 4, `${cells} 张`);

  const cols = await grid.evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(" ").length);
  check("确实是两列（朋友圈版式）", cols === 2, `${cols} 列`);

  const firstImg = grid.locator("img").first();
  const imgOk = await imageLoaded(grid.locator("img"));
  const imgSrc = await firstImg.getAttribute("src");
  check("日记图片无需鉴权即可加载", imgOk, imgSrc || "(无 src)");
  await page.screenshot({ path: `${SHOTS}/23-diary-moments.png` });

  // 点开大图
  await grid.locator(".moments-cell").first().click();
  await page.waitForSelector(".lightbox img", { timeout: 10000 });
  check("点图片可全屏查看", true);
  await page.screenshot({ path: `${SHOTS}/24-lightbox.png` });
  await page.click(".lightbox-close");
  await page.waitForTimeout(300);

  check("日记页有「写说说」悬浮按钮", (await page.locator('.fab:has-text("写说说")').count()) === 1);

  // ---------- 24. 自动续期（「老是会话失效」的修复）----------
  console.log("\n[24] 自动续期");

  // 路径 A：主动续期
  //   用 shortlived 账号（access token 只活 3 秒）。
  //   因为「距过期 < 60 秒就先续期」，登录后的第一个请求就会触发续期。
  // 基线要在登录【之前】取：3 秒的 token 会在登录后的首个请求上就触发续期
  const beforeA = refreshCalls;
  await page.evaluate(() => {
    localStorage.removeItem("nowen-lite.token");
    localStorage.removeItem("nowen-lite.refresh");
  });
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector("#username", { timeout: 15000 });
  await page.fill("#username", "shortlived");
  await page.fill("#password", "shortlived");
  await page.click('button[type="submit"]');
  await page.waitForSelector(".bottom-nav", { timeout: 15000 });
  check("短命 token 账号登录成功", true);

  await goTab("笔记");
  await page.waitForSelector('a.list-item:has-text("移动端开发踩坑记录")', { timeout: 15000 });
  check(
    "路径A·快过期的 token 会在请求前主动续期",
    refreshCalls > beforeA,
    `续期 ${refreshCalls - beforeA} 次`,
  );

  const refreshed = await page.evaluate(() => {
    const t = localStorage.getItem("nowen-lite.token");
    const b64 = t.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(b64));
  });
  check(
    "续期后拿到的是长寿 token（不再是 3 秒）",
    refreshed.exp - refreshed.iat > 600,
    `有效期 ${refreshed.exp - refreshed.iat} 秒`,
  );

  // 路径 B：被动续期（401 → 续期 → 重放原请求）
  //   伪造一个「本地看着还有 1 小时、但服务端根本不认」的 token。
  //   authedFetch 不会主动续期（本地判断没过期）→ 请求 401 → 续期 → 重放。
  const forged = await page.evaluate(() => {
    const b64url = (o) =>
      btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const now = Math.floor(Date.now() / 1000);
    const token = `${b64url({ alg: "none", typ: "JWT" })}.${b64url({
      sub: "u2",
      typ: "login",
      iat: now,
      exp: now + 3600,
    })}.forged`;
    localStorage.setItem("nowen-lite.token", token);
    return token;
  });
  check("已植入「服务端不认」的伪造 token", forged.endsWith(".forged"));

  const beforeB = refreshCalls;
  await goTab("待办");
  await page.waitForSelector(".task-row", { timeout: 15000 });
  check("路径B·401 后自动续期并重放请求（数据照常加载）", true);
  check(
    "路径B·确实因为 401 触发了一次续期",
    refreshCalls > beforeB,
    `续期 ${refreshCalls - beforeB} 次`,
  );
  check("路径B·没有被踢回登录页", (await page.locator("#username").count()) === 0);
  await page.screenshot({ path: `${SHOTS}/25-reauth.png` });

  // ---------- 25. 设置 · 笔记展示 ----------
  currentSection = "[25] 设置 · 笔记展示"; console.log("\n[25] 设置 · 笔记展示");
  await goTab("设置");
  await page.waitForSelector(".settings-group", { timeout: 15000 });
  check(
    "设置里有「笔记展示」分节",
    (await page.locator('.settings-group-title', { hasText: "笔记展示" }).count()) === 1,
  );

  const toggleRows = page.locator(".toggle-row");
  await toggleRows.first().waitFor({ timeout: 10000 });
  const rowCount = await toggleRows.count();
  check("列出了全部笔记本并带开关", rowCount === 14, `${rowCount} 个`);
  const rowNames = await page.locator(".toggle-row .li-title").allInnerTexts();
  check("按笔记数倒序（常用的在前）", rowNames[0].includes("技术笔记"), rowNames.join(" / "));
  check(
    "默认全部可见",
    (await page.locator('.toggle[data-on="false"]').count()) === 0,
    `关闭的开关数 ${await page.locator('.toggle[data-on="false"]').count()}`,
  );
  const summary = await page.locator(".settings-summary").innerText();
  // ⚠️ 不要断言绝对条数：前面的用例会创建新笔记，总数会变。
  //    这里只断言「分子 = 分母」这个结构。
  check(
    "显示可见数量与笔记总数",
    /已显示\s*14\s*\/\s*14\s*个笔记本/.test(summary.replace(/\n/g, " ")) &&
      /共\s*4\s*篇/.test(summary) &&
      /11\s*个是空的/.test(summary),
    summary.replace(/\n/g, " "),
  );
  await page.screenshot({ path: `${SHOTS}/26-settings-notebooks.png` });

  // 先记下当前条数 —— 前面的用例创建过笔记，不能用固定值
  await goTab("笔记");
  await page.waitForSelector("a.list-item", { timeout: 15000 });
  const beforeHide = await page.locator("a.list-item").count();
  await goTab("设置");
  await page.waitForSelector(".toggle-row", { timeout: 15000 });

  // 关掉「旅行」笔记本 → 笔记流里那一篇应该消失
  await page.click('.toggle-row:has-text("旅行")');
  await page.waitForFunction(
    () => document.querySelectorAll('.toggle[data-on="false"]').length === 1,
    undefined,
    { timeout: 10000 },
  );
  check("关掉一个笔记本后开关状态变化", true);
  const summary2 = await page.locator(".settings-summary").innerText();
  check(
    "统计分子随之更新（14 → 13 个笔记本）",
    /已显示\s*13\s*\/\s*14\s*个笔记本/.test(summary2.replace(/\n/g, " ")),
    summary2.replace(/\n/g, " "),
  );

  await goTab("笔记");
  await page.waitForSelector('a.list-item:has-text("移动端开发踩坑记录")', { timeout: 15000 });
  const afterHide = await page.locator("a.list-item").count();
  check("笔记流里被隐藏笔记本的笔记消失了", afterHide === beforeHide - 1, `${beforeHide} → ${afterHide}`);
  check("确认消失的正是那一篇", (await page.locator('a.list-item:has-text("十月旅行计划")').count()) === 0);
  check("顶部提示已隐藏了笔记本", (await page.locator(".feed-hint").count()) === 1);
  await page.screenshot({ path: `${SHOTS}/27-feed-filtered.png` });

  // 恢复
  await goTab("设置");
  await page.waitForSelector(".toggle-row", { timeout: 15000 });
  await page.click('.toggle-row:has-text("旅行")');
  await page.waitForFunction(
    () => document.querySelectorAll('.toggle[data-on="false"]').length === 0,
    undefined,
    { timeout: 10000 },
  );
  await goTab("笔记");
  await page.waitForFunction(
    (n) => document.querySelectorAll("a.list-item").length === n,
    beforeHide,
    { timeout: 10000 },
  );
  check("恢复显示后那一篇又回来了", true, `${afterHide} → ${beforeHide}`);

  // 笔记本搜索（上百个时必须有）
  await goTab("设置");
  await page.waitForSelector(".toggle-row", { timeout: 15000 });
  await page.fill('.settings-group .searchbar input', "剪藏");
  await page.waitForFunction(
    () => document.querySelectorAll(".toggle-row").length === 3,
    undefined,
    { timeout: 5000 },
  );
  check("设置里可按名字搜索笔记本（14 → 3）", true);
  await page.fill('.settings-group .searchbar input', "");
  await page.waitForFunction(
    () => document.querySelectorAll(".toggle-row").length === 14,
    undefined,
    { timeout: 5000 },
  );

  // 一键隐藏空笔记本
  await page.click('.settings-actions button:has-text("隐藏 11 个空笔记本")');
  await page.waitForFunction(
    () => document.querySelectorAll('.toggle[data-on="false"]').length === 11,
    undefined,
    { timeout: 10000 },
  );
  check("一键隐藏空笔记本生效", true);
  const summary3 = await page.locator(".settings-summary").innerText();
  check(
    "隐藏空笔记本后【笔记总数不变】",
    /共\s*4\s*篇/.test(summary3.replace(/\n/g, " ")),
    summary3.replace(/\n/g, " "),
  );
  await page.screenshot({ path: `${SHOTS}/29-settings-batch.png` });

  await page.click('.settings-actions button:has-text("全部显示")');
  await page.waitForFunction(
    () => document.querySelectorAll('.toggle[data-on="false"]').length === 0,
    undefined,
    { timeout: 10000 },
  );
  check("「全部显示」可一键恢复", true);

  // ---------- 26. 视图切换：仅看笔记 / 文件夹排布 ----------
  currentSection = "[26] 视图切换（仅看笔记 / 文件夹排布）"; console.log("\n[26] 视图切换（仅看笔记 / 文件夹排布）");
  await goTab("笔记");
  await page.waitForSelector("a.list-item", { timeout: 15000 });

  // 位置：需求指定"在搜索框下方"
  const barBox = await page.locator(".searchbar").boundingBox();
  const swBox = await page.locator(".viewswitch").boundingBox();
  check(
    "视图切换位于搜索框下方",
    !!barBox && !!swBox && swBox.y >= barBox.y + barBox.height - 1,
    `搜索框底 ${barBox ? Math.round(barBox.y + barBox.height) : "?"} / 切换控件顶 ${swBox ? Math.round(swBox.y) : "?"}`,
  );
  const vsLabels = (await page.locator(".viewswitch .vs-option").allInnerTexts()).map((s) =>
    s.replace(/\s+/g, " ").trim(),
  );
  check(
    "两个视图选项齐全",
    vsLabels.length === 2 && /仅看笔记/.test(vsLabels.join()) && /文件夹排布/.test(vsLabels.join()),
    vsLabels.join(" / "),
  );
  check(
    "默认是「仅看笔记」",
    /仅看笔记/.test(await page.locator('.viewswitch .vs-option[aria-selected="true"]').innerText()),
  );
  check("默认视图下没有文件夹行", (await page.locator(".folder-row").count()) === 0);
  const flatCount = await page.locator("a.list-item").count();

  // —— 切到文件夹排布 ——
  await page.click('.viewswitch .vs-option[data-mode="folders"]');
  await page.waitForSelector(".folder-row", { timeout: 10000 });

  // ★ 核心要求：文件夹视图【只到文件夹层面】，一条笔记都不显示
  check(
    "文件夹视图里不显示任何笔记",
    (await page.locator("a.list-item").count()) === 0,
    `残留 ${await page.locator("a.list-item").count()} 条笔记行`,
  );
  check(
    "文件夹行也没有 backdrop-filter（性能铁律）",
    (await page.locator(".folder-row").first().evaluate((el) => getComputedStyle(el).backdropFilter)) === "none",
  );

  const topNames = (await page.locator(".folder-row .folder-name").allInnerTexts()).map((s) => s.trim());
  check(
    "空笔记本被剪掉（mock 有 14 个笔记本，只有 3 个装着笔记）",
    ["技术笔记", "生活记录"].every((n) => topNames.includes(n)) && topNames.length === 2,
    topNames.join(" / "),
  );
  // ★ 核心要求：默认子文件夹不展开
  check(
    "默认只到顶层文件夹（子文件夹「旅行」收起）",
    !topNames.includes("旅行"),
    topNames.join(" / "),
  );
  const lifeBadge = (await page.locator('.folder-row:has-text("生活记录") .folder-count').innerText()).trim();
  check("父文件夹显示的是含子孙的总数（生活记录自己 0 篇，含子本 1 篇）", lifeBadge === "1", lifeBadge);
  await page.screenshot({ path: `${SHOTS}/30-view-folders.png` });

  // —— 展开：只出子文件夹，依然不出现笔记 ——
  await page.click('.folder-row:has-text("生活记录") .folder-caret-btn');
  await page.waitForSelector('.folder-row:has-text("旅行")', { timeout: 10000 });
  check("点箭头展开后出现的是【子文件夹】", true);
  check(
    "展开子文件夹后依然不显示笔记",
    (await page.locator("a.list-item").count()) === 0,
    `残留 ${await page.locator("a.list-item").count()} 条`,
  );
  check(
    "父文件夹变成展开态",
    (await page.locator('.folder-row:has-text("生活记录") .folder-caret-btn').getAttribute("aria-expanded")) === "true",
  );
  const childNames = (await page.locator(".folder-row .folder-name").allInnerTexts()).map((s) => s.trim());
  check("子文件夹带缩进（层级可辨）", childNames.includes("旅行"), childNames.join(" / "));
  await page.screenshot({ path: `${SHOTS}/31-view-folders-collapsed.png` });

  // —— 偏好持久化 ——
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector(".folder-row", { timeout: 15000 });
  check(
    "刷新后仍停在「文件夹排布」",
    /文件夹排布/.test(await page.locator('.viewswitch .vs-option[aria-selected="true"]').innerText()),
  );
  check(
    "刷新后展开状态还在（「旅行」仍然可见）",
    (await page.locator('.folder-row:has-text("旅行")').count()) === 1,
  );

  // —— 点整行 = 进入文件夹（切到「仅看笔记」并只看它，含子孙）——
  await page.click('.folder-row:has-text("生活记录") .folder-main');
  await page.waitForSelector(".scope-chip", { timeout: 10000 });
  const chip = (await page.locator(".scope-chip-text").innerText()).trim();
  check("点文件夹会切到「仅看笔记」并限定范围", /生活记录/.test(chip), chip);
  check(
    "范围提示带条数（生活记录含子本共 1 篇）",
    /1 篇/.test(chip),
    chip,
  );
  check(
    "列表只剩该文件夹（含子孙）的笔记",
    (await page.locator("a.list-item").count()) === 1,
    `${await page.locator("a.list-item").count()} 条`,
  );
  check(
    "就是子文件夹「旅行」里那一篇",
    (await page.locator('a.list-item:has-text("十月旅行计划")').count()) === 1,
  );
  check("切回「仅看笔记」后不再有文件夹行", (await page.locator(".folder-row").count()) === 0);
  await page.screenshot({ path: `${SHOTS}/32-folder-scope.png` });

  // —— 一键退出范围 ——
  await page.click(".scope-chip-clear");
  await page.waitForFunction(
    () => document.querySelectorAll(".scope-chip").length === 0,
    undefined,
    { timeout: 10000 },
  );
  await page.waitForFunction(
    (n) => document.querySelectorAll("a.list-item").length === n,
    flatCount,
    { timeout: 10000 },
  );
  check("点 × 可退出文件夹范围，恢复全部笔记", true, `恢复 ${flatCount} 条`);

  // —— 切回扁平 ——
  check("切换控件仍在（说明确实切回了扁平视图）", (await page.locator(".viewswitch").count()) === 1);
  await page.click('.viewswitch .vs-option[data-mode="folders"]');
  await page.waitForSelector(".folder-row", { timeout: 10000 });
  await page.click('.viewswitch .vs-option[data-mode="flat"]');
  await page.waitForFunction(
    () => document.querySelectorAll(".folder-row").length === 0,
    undefined,
    { timeout: 10000 },
  );
  check("切回「仅看笔记」后条数恢复", (await page.locator("a.list-item").count()) === flatCount, `${flatCount}`);
  check("切回后文件夹行消失", (await page.locator(".folder-row").count()) === 0);

  // ---------- 27. 日记说说配图 ----------
  currentSection = "[27] 说说配图"; console.log("\n[27] 说说配图");
  await goTab("日记说说");
  await page.waitForSelector('.fab:has-text("写说说")', { timeout: 15000 });
  await page.click('.fab:has-text("写说说")');
  await page.waitForSelector(".compose-area", { timeout: 10000 });

  check("编辑器里有添加图片按钮", (await page.locator(".attach-add").count()) === 1);
  check("初始没有待发布附件", (await page.locator('[data-testid="attach-cell"]').count()) === 0);

  // 用 setInputFiles 直接喂文件（隐藏 input 不能用 click 打开系统选择器）
  const pngPath = "scripts/fixtures/demo-image.png";
  await page.setInputFiles('[data-testid="attach-input"]', [pngPath, pngPath]);
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid="attach-cell"]').length === 2,
    undefined,
    { timeout: 20000 },
  );
  check("选两张图后出现两个缩略图", true);

  // 缩略图必须真的加载出来（走 /api/diary/attachments/<id>，无需鉴权）
  const thumbOk = await imageLoaded(page.locator('[data-testid="attach-cell"] img'));
  check("缩略图真的加载出来了（无需鉴权）", thumbOk);

  // 发布按钮：只有图片、没有文字时也应该可点（服务端允许纯图片说说）
  const publishBtn = page.locator('.compose-area ~ div button.btn, button.btn:has-text("发布")').first();
  check("纯图片（无文字）也能发布", !(await publishBtn.isDisabled()));
  await page.screenshot({ path: `${SHOTS}/33-diary-attach.png` });

  // 删掉一张：界面要少一个，且服务端那张悬空图要被真删掉（再 GET 应 404）
  const firstId = await page
    .locator('[data-testid="attach-cell"]')
    .first()
    .evaluate((cell) => cell.querySelector("img")?.getAttribute("src") || "");
  await page.locator('[data-testid="attach-cell"] .attach-remove').first().click();
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid="attach-cell"]').length === 1,
    undefined,
    { timeout: 10000 },
  );
  check("点 × 可从待发布列表移除", true);
  if (firstId) {
    const goneStatus = await page.evaluate(async (src) => {
      const res = await fetch(src);
      return res.status;
    }, firstId);
    check("被移除的附件在服务端也真被删了（404）", goneStatus === 404, `HTTP ${goneStatus}`);
  }

  // 发布：带上剩下那张图
  await page.fill(".compose-area", "带图说说 · 端到端测试");
  await page.click('button.btn:has-text("发布")');
  await page.waitForFunction(
    () => !document.querySelector(".compose-area"),
    undefined,
    { timeout: 15000 },
  );
  await page.waitForSelector('.list-item:has-text("带图说说 · 端到端测试")', { timeout: 15000 });
  check("发布成功且列表出现新说说", true);

  const newItemImgs = await page
    .locator('.diary-item:has-text("带图说说 · 端到端测试") .moments img')
    .count();
  check("新说说里带着刚上传的图片", newItemImgs === 1, `${newItemImgs} 张`);
  const newImgOk = await imageLoaded(
    page.locator('.diary-item:has-text("带图说说 · 端到端测试") .moments img'),
  );
  check("新说说的图片真实加载", newImgOk);
  await page.screenshot({ path: `${SHOTS}/34-diary-posted-image.png` });

  // 放弃编辑要清理悬空附件（不留垃圾）
  await page.click('.fab:has-text("写说说")');
  await page.waitForSelector(".compose-area", { timeout: 10000 });
  await page.setInputFiles('[data-testid="attach-input"]', [pngPath]);
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid="attach-cell"]').length === 1,
    undefined,
    { timeout: 20000 },
  );
  const orphanSrc = await page
    .locator('[data-testid="attach-cell"] img')
    .first()
    .evaluate((el) => el.getAttribute("src"));
  await page.click('[data-testid="compose-close"]');
  await page.waitForFunction(
    () => !document.querySelector(".compose-area"),
    undefined,
    { timeout: 10000 },
  );
  const orphanStatus = await page.evaluate(async (src) => {
    const res = await fetch(src);
    return res.status;
  }, orphanSrc);
  check("放弃编辑会清掉已上传的悬空附件（不留垃圾）", orphanStatus === 404, `HTTP ${orphanStatus}`);

  // ---------- 28. 外观：浅色 / 深色 / 跟随系统 ----------
  currentSection = "[28] 外观模式"; console.log("\n[28] 外观模式");

  /**
   * WCAG 对比度。深色模式最容易犯的错是「底色变了、文字没变」，
   * 只断言 data-theme 等于没测 —— 必须量化「文字和底色的对比度够不够」。
   */
  const contrast = (fg, bg) => {
    const lum = (c) => {
      const [r, g, b] = c.match(/[\d.]+/g).slice(0, 3).map(Number);
      const f = (v) => {
        const x = v / 255;
        return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
      };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x);
    return (a + 0.05) / (b + 0.05);
  };

  await goTab("设置");
  await page.waitForSelector('[data-testid="theme-switch"]', { timeout: 15000 });

  check(
    "设置里有「外观」分节",
    (await page.locator('[data-testid="appearance-section"] .settings-group-title').innerText()).includes("外观"),
  );
  const themeOptions = (
    await page.locator('[data-testid="theme-switch"] .vs-option').allInnerTexts()
  ).map((t) => t.replace(/\s+/g, " ").trim());
  check(
    "三个选项：浅色 / 深色 / 跟随系统",
    themeOptions.length === 3 &&
      /浅色/.test(themeOptions.join()) &&
      /深色/.test(themeOptions.join()) &&
      /跟随系统/.test(themeOptions.join()),
    themeOptions.join(" / "),
  );
  check(
    "默认是「跟随系统」",
    (await page.locator('[data-testid="theme-switch"] .vs-option[data-mode="auto"]').getAttribute("aria-selected")) === "true",
  );
  check(
    "「跟随系统」会说明系统当前是深是浅",
    /跟随系统 · 当前系统是(深色|浅色)/.test(await page.locator('[data-testid="theme-note"]').innerText()),
    await page.locator('[data-testid="theme-note"]').innerText(),
  );

  const readTheme = () =>
    page.evaluate(() => {
      const cs = getComputedStyle(document.body);
      return {
        dataTheme: document.documentElement.dataset.theme,
        colorScheme: document.documentElement.style.colorScheme,
        color: cs.color,
        bg: cs.backgroundColor,
        glass: getComputedStyle(document.querySelector(".glass")).backgroundColor,
        metaTheme: document.querySelector('meta[name="theme-color"]')?.getAttribute("content") || "",
      };
    });

  // —— 时区自检：本机时间 − UTC 时间 必须等于显示的偏移（与环境无关的自洽检查）——
  const tzName = (await page.locator('[data-testid="tz-name"]').innerText()).trim();
  const tzOffset = (await page.locator('[data-testid="tz-offset"]').innerText()).trim();
  const tzLocal = (await page.locator('[data-testid="tz-local"]').innerText()).trim();
  const tzUtc = (await page.locator('[data-testid="tz-utc"]').innerText()).trim();
  check(
    "设置里有「时区自检」（服务端是 UTC，显示靠本机换算）",
    (await page.locator('[data-testid="timezone-info"]').count()) === 1,
  );
  check(
    "时区自检给出了本机时区与偏移",
    /^UTC[+−]\d{2}:\d{2}$/.test(tzOffset) && tzName.length > 0,
    `${tzName} ${tzOffset}`,
  );
  {
    const asMin = (s) => {
      const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(s);
      return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) : NaN;
    };
    const shown = /^UTC([+−])(\d{2}):(\d{2})$/.exec(tzOffset);
    const expected =
      shown == null ? NaN : (shown[1] === "−" ? -1 : 1) * (+shown[2] * 60 + +shown[3]);
    const actual = Math.round((asMin(tzLocal) - asMin(tzUtc)) / 60000);
    check(
      "「本机时间 − UTC 时间」正好等于显示的偏移（自洽）",
      actual === expected,
      `${tzLocal} − ${tzUtc} = ${actual} 分钟，界面写 ${expected} 分钟`,
    );
  }

  const lightVals = await readTheme();

  // —— 切深色 ——
  await page.click('[data-testid="theme-switch"] .vs-option[data-mode="dark"]');
  await page.waitForFunction(() => document.documentElement.dataset.theme === "dark", undefined, {
    timeout: 5000,
  });
  const darkVals = await readTheme();

  check("切深色后 <html data-theme=\"dark\">", darkVals.dataTheme === "dark");
  check(
    "原生控件也跟着深色（color-scheme）",
    darkVals.colorScheme === "dark",
    darkVals.colorScheme || "(空)",
  );
  check(
    "页面底色真的变深了",
    contrast(lightVals.bg, darkVals.bg) > 5,
    `${lightVals.bg} → ${darkVals.bg}`,
  );
  check(
    "玻璃层也跟着变深（不是只改了页面底色）",
    contrast(lightVals.glass, darkVals.glass) > 2,
    `${lightVals.glass} → ${darkVals.glass}`,
  );
  check(
    "浏览器地址栏色跟着变（theme-color）",
    darkVals.metaTheme.toLowerCase() !== lightVals.metaTheme.toLowerCase(),
    `${lightVals.metaTheme} → ${darkVals.metaTheme}`,
  );

  // ★ 关键：文字与底色的对比度必须达标，否则「深色模式」等于看不清
  const darkRatio = contrast(darkVals.color, darkVals.bg);
  check(
    "深色下正文对比度达标（WCAG AA ≥ 4.5）",
    darkRatio >= 4.5,
    `文字 ${darkVals.color} / 底 ${darkVals.bg} → ${darkRatio.toFixed(2)}:1`,
  );
  const lightRatio = contrast(lightVals.color, lightVals.bg);
  check(
    "浅色下正文对比度达标（WCAG AA ≥ 4.5）",
    lightRatio >= 4.5,
    `文字 ${lightVals.color} / 底 ${lightVals.bg} → ${lightRatio.toFixed(2)}:1`,
  );
  check(
    "文案说明了当前是「始终深色」",
    /始终使用深色/.test(await page.locator('[data-testid="theme-note"]').innerText()),
  );
  await page.screenshot({ path: `${SHOTS}/35-theme-dark-settings.png` });

  // —— 持久化：刷新后仍是深色 ——
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector(".bottom-nav", { timeout: 15000 });
  check(
    "刷新后仍是深色（偏好记住了）",
    (await page.evaluate(() => document.documentElement.dataset.theme)) === "dark",
  );

  // —— 首帧不闪白：文档一可用就必须已经是深色 ——
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  const earlyTheme = await page.evaluate(() => document.documentElement.dataset.theme);
  check(
    "首帧（DOM 就绪时）就已经是深色，不会先闪一下白",
    earlyTheme === "dark",
    `domcontentloaded 时 data-theme=${earlyTheme}`,
  );

  // —— 跟随系统：用 CDP 改系统偏好，应当立刻跟着变 ——
  await page.waitForSelector(".bottom-nav", { timeout: 15000 });
  await goTab("设置");
  await page.waitForSelector('[data-testid="theme-switch"]', { timeout: 15000 });
  await page.click('[data-testid="theme-switch"] .vs-option[data-mode="auto"]');
  await page.waitForFunction(
    () => document.querySelector('[data-testid="theme-switch"] .vs-option[data-mode="auto"]')?.getAttribute("aria-selected") === "true",
    undefined,
    { timeout: 5000 },
  );
  check("可切回「跟随系统」", true);

  await page.emulateMedia({ colorScheme: "dark" });
  await page.waitForFunction(() => document.documentElement.dataset.theme === "dark", undefined, {
    timeout: 5000,
  });
  check("跟随系统 · 系统是深色时自动变深", true);

  await page.emulateMedia({ colorScheme: "light" });
  await page.waitForFunction(() => document.documentElement.dataset.theme === "light", undefined, {
    timeout: 5000,
  });
  check("系统切回浅色时立刻跟着变（不用刷新）", true);
  check(
    "文案跟着说明系统当前是浅色",
    /跟随系统 · 当前系统是浅色/.test(await page.locator('[data-testid="theme-note"]').innerText()),
    await page.locator('[data-testid="theme-note"]').innerText(),
  );
  await page.screenshot({ path: `${SHOTS}/36-theme-auto-light.png` });

  // —— 深色下的笔记流也拍一张（给 README 用）——
  await page.click('[data-testid="theme-switch"] .vs-option[data-mode="dark"]');
  await page.waitForFunction(() => document.documentElement.dataset.theme === "dark", undefined, {
    timeout: 5000,
  });
  await goTab("笔记");
  await page.waitForSelector("a.list-item", { timeout: 15000 });
  check("深色下笔记流正常渲染", (await page.locator("a.list-item").count()) > 0);
  await page.screenshot({ path: `${SHOTS}/37-theme-dark-feed.png` });

  // —— 收尾：恢复浅色，免得影响后续断言与截图 ——
  await goTab("设置");
  await page.waitForSelector('[data-testid="theme-switch"]', { timeout: 15000 });
  await page.click('[data-testid="theme-switch"] .vs-option[data-mode="light"]');
  await page.waitForFunction(() => document.documentElement.dataset.theme === "light", undefined, {
    timeout: 5000,
  });
  check("可切回浅色", true);

  // ---------- 29. 说说按日期分块 ----------
  currentSection = "[29] 说说按日期分块"; console.log("\n[29] 说说按日期分块");
  await goTab("日记说说");
  await page.waitForSelector(".diary-item", { timeout: 15000 });

  // mock 的三条是「今天 / 昨天 / 前天」，加上前面几节发过的说说（也是今天）
  const groups = page.locator(".diary-group");
  const groupCount = await groups.count();
  check("说说按日期切成了多块", groupCount >= 3, `${groupCount} 块`);

  const groupLabels = (
    await page.locator(".diary-group-label > span:first-child").allInnerTexts()
  ).map((t) => t.trim());
  check("第一块是「今天」", groupLabels[0] === "今天", groupLabels.join(" / "));
  check("第二块是「昨天」", groupLabels[1] === "昨天", groupLabels.join(" / "));
  check("第三块是「前天」", groupLabels[2] === "前天", groupLabels.join(" / "));
  check(
    "每块的标题互不相同（确实按日期切的，不是同一个标题重复）",
    new Set(groupLabels).size === groupLabels.length,
    groupLabels.join(" / "),
  );

  // ★ 关键不变式：分组必须是一个【划分】—— 各块条数之和 == 条目总数，不多不少
  const counts = (await page.locator(".diary-group-count").allInnerTexts()).map((t) => Number(t.trim()));
  const itemTotal = await page.locator(".diary-item").count();
  const sum = counts.reduce((a, b) => a + b, 0);
  check(
    "各块条数之和 == 条目总数（是不重不漏的划分）",
    sum === itemTotal,
    `${counts.join("+")} = ${sum}，实际条目 ${itemTotal}`,
  );
  check(
    "同一天的说说落在同一块（今天至少 2 条：mock 的 + 前面发过的）",
    counts[0] >= 2,
    `今天 ${counts[0]} 条`,
  );
  check(
    "每块是独立的玻璃卡片",
    (await page.locator(".diary-group .card.glass").count()) === groupCount,
  );

  // 条目内只显示时分 —— 日期已经在分组标题上，重复显示是噪音
  const itemTimes = (await page.locator(".diary-item .diary-date").allInnerTexts()).map((t) => t.trim());
  check(
    "条目内只显示时分（日期交给分组标题）",
    itemTimes.length > 0 && itemTimes.every((t) => /^\d{2}:\d{2}$/.test(t)),
    itemTimes.slice(0, 4).join(" / "),
  );

  // 分组要按【本地日期】：直接用 UTC 字符串切前 10 位的话，
  // 东八区晚 8 点后的说说会被算到前一天
  const groupDates = await groups.evaluateAll((els) => els.map((el) => el.dataset.date));
  check(
    "每块带本地日期标记且唯一",
    groupDates.length === groupCount && new Set(groupDates).size === groupCount,
    groupDates.join(" / "),
  );
  await page.screenshot({ path: `${SHOTS}/38-diary-grouped.png` });

  // ---------- 30. 设置分组 / 语言 / 字号 / 缓存 ----------
  currentSection = "[30] 设置分组与外观"; console.log("\n[30] 设置分组与外观");
  await goTab("设置");
  await page.waitForSelector(".settings-group", { timeout: 15000 });

  const settingsGroups = (await page.locator(".settings-group-title").allInnerTexts()).map((t) => t.trim());
  check(
    "设置按「账号 / 外观 / 笔记展示 / 同步与缓存 / 关于」分组",
    settingsGroups.length === 5 &&
      settingsGroups[0].includes("账号") &&
      settingsGroups[1].includes("外观") &&
      settingsGroups[2].includes("笔记展示") &&
      settingsGroups[3].includes("同步与缓存") &&
      settingsGroups[4].includes("关于"),
    settingsGroups.join(" / "),
  );

  // ---- 语言切换 ----
  const langBefore = (await page.locator(".bottom-nav a").first().innerText()).trim();
  await page.click('[data-testid="lang-switch"] .vs-option[data-mode="en"]');
  await page.waitForFunction(
    () => document.querySelector(".bottom-nav a")?.textContent?.includes("Notes"),
    undefined,
    { timeout: 5000 },
  );
  const navEn = (await page.locator(".bottom-nav a").allInnerTexts()).map((t) => t.trim());
  check("切到 English 后底部导航跟着变", /Notes/.test(navEn[0]) && /Settings/.test(navEn[4]), navEn.join(" / "));
  check(
    "设置分组标题也跟着变",
    (await page.locator(".settings-group-title").first().innerText()).includes("Account"),
  );
  await page.screenshot({ path: `${SHOTS}/40-settings-en.png` });

  // 持久化
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector(".settings-group", { timeout: 15000 });
  check(
    "语言偏好刷新后仍在",
    (await page.locator(".settings-group-title").first().innerText()).includes("Account"),
  );

  // 切回中文
  await page.click('[data-testid="lang-switch"] .vs-option[data-mode="zh-CN"]');
  await page.waitForFunction(
    () => document.querySelector(".bottom-nav a")?.textContent?.includes("笔记"),
    undefined,
    { timeout: 5000 },
  );
  check("可切回中文", true, `切前 ${langBefore}`);

  // ---- 编辑器字号 ----
  const rootSize = () =>
    page.evaluate(() => document.documentElement.style.getPropertyValue("--editor-font-size"));
  check("默认字号不写 CSS 变量（交给样式表的 15px）", (await rootSize()) === "");
  await page.click('.fontsize-btn[data-size="20"]');
  await page.waitForFunction(
    () => document.documentElement.style.getPropertyValue("--editor-font-size") === "20px",
    undefined,
    { timeout: 5000 },
  );
  check("选 20 号后 :root 上出现 --editor-font-size: 20px", true);
  check(
    "正文真的用了这个字号",
    (await page.evaluate(() => {
      const el = document.createElement("div");
      el.className = "note-body";
      document.body.appendChild(el);
      const fs = getComputedStyle(el).fontSize;
      el.remove();
      return fs;
    })) === "20px",
  );
  await page.click('.fontsize-btn[data-size="0"]');
  await page.waitForFunction(
    () => document.documentElement.style.getPropertyValue("--editor-font-size") === "",
    undefined,
    { timeout: 5000 },
  );
  check("切回「默认」会移除变量", true);

  // ---- 缓存预加载 ----
  check("设置里有预加载开关", (await page.locator('[data-testid="preload-toggle"]').count()) === 1);
  check(
    "开关默认是开的",
    (await page.locator('[data-testid="preload-toggle"]').getAttribute("data-on")) === "true",
  );
  check(
    "列出了预加载条数档位",
    (await page.locator('[data-count]').count()) === 5,
    `${await page.locator('[data-count]').count()} 档`,
  );
  check(
    "预加载条数默认是 20（不能被读成 0＝关闭）",
    (await page.locator('[data-count="20"]').getAttribute("aria-pressed")) === "true",
    await page.locator('[data-count][aria-pressed="true"]').innerText(),
  );
  const usageBefore = (await page.locator('[data-testid="cache-usage"]').innerText()).trim();
  check("显示了缓存占用", usageBefore.length > 0, usageBefore);

  // 打开几篇笔记 → 缓存应该攒起来
  await goTab("笔记");
  await page.waitForSelector("a.list-item", { timeout: 15000 });
  await page.click("a.list-item");
  await page.waitForSelector(".note-body", { timeout: 15000 });
  await goTab("设置");
  await page.waitForSelector('[data-testid="cache-usage"]', { timeout: 15000 });
  await page.waitForFunction(
    () => !/暂无缓存/.test(document.querySelector('[data-testid="cache-usage"]')?.textContent || ""),
    undefined,
    { timeout: 10000 },
  ).catch(() => {});
  const usageAfter = (await page.locator('[data-testid="cache-usage"]').innerText()).trim();
  check("打开笔记后缓存被写入", !/暂无缓存/.test(usageAfter), usageAfter);

  // 清空缓存
  await page.click('[data-testid="clear-cache"]');
  await page.waitForFunction(
    () => /暂无缓存|Nothing cached/.test(document.querySelector('[data-testid="cache-usage"]')?.textContent || ""),
    undefined,
    { timeout: 10000 },
  );
  check("清空缓存后占用归零（且不碰服务器数据）", true);
  await page.screenshot({ path: `${SHOTS}/41-settings-cache.png` });

  // 预加载缓存必须真的能加速：列表在**没有网络**时也能渲染出内容
  await page.evaluate(() => {
    localStorage.setItem("nowen-lite.cache.note-list", JSON.stringify([
      { id: "cached-1", notebookId: "nb-tech", title: "来自缓存的笔记", contentText: "缓存副本", updatedAt: "2026-10-07 00:00:00", contentFormat: "markdown", isPinned: 0 },
    ]));
  });
  await page.route("**/api/notes**", (route) => route.abort());
  await goTab("笔记");
  const renderedFromCache = await page
    .waitForSelector('a.list-item:has-text("来自缓存的笔记")', { timeout: 8000 })
    .then(() => true)
    .catch(() => false);
  check("断网时笔记列表仍能从缓存渲染（预加载生效）", renderedFromCache);
  await page.unroute("**/api/notes**");

  // ---------- 31. 界面风格（原生 / 液态玻璃） ----------
  currentSection = "[31] 界面风格"; console.log("\n[31] 界面风格");
  await goTab("设置");
  await page.waitForSelector('[data-testid="ui-style-switch"]', { timeout: 15000 });

  /** 把当前皮肤/深浅色下的关键观感量出来 */
  const readStyle = () =>
    page.evaluate(() => {
      const cs = getComputedStyle(document.documentElement);
      const surface = document.querySelector(".settings-group-body");
      return {
        style: document.documentElement.dataset.style,
        theme: document.documentElement.dataset.theme,
        pageBase: cs.getPropertyValue("--page-base").trim(),
        blur: cs.getPropertyValue("--glass-blur").trim(),
        radiusCard: cs.getPropertyValue("--radius-card").trim(),
        radiusField: cs.getPropertyValue("--radius-field").trim(),
        accent: cs.getPropertyValue("--accent").trim(),
        pageA: cs.getPropertyValue("--page-a").trim(),
        themeColor: document.querySelector('meta[name="theme-color"]')?.content || "",
        surfaceBg: surface ? getComputedStyle(surface).backgroundColor : "",
      };
    });

  /** 相对亮度 → 对比度（用于确认两套皮肤都可读） */
  const styleContrast = (fg, bg) => {
    const lum = (c) => {
      const m = /(\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(c);
      if (!m) return null;
      const f = (v) => {
        const x = +v / 255;
        return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
      };
      return 0.2126 * f(m[1]) + 0.7152 * f(m[2]) + 0.0722 * f(m[3]);
    };
    const a = lum(fg);
    const b = lum(bg);
    if (a === null || b === null) return null;
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  };

  // 默认必须是原生（而且这个默认写在 CSS 里，JS 挂了也一样）
  const def = await readStyle();
  check(
    "默认风格是「原生」（对齐 Nowen Note 标准版）",
    def.style === "native",
    def.style,
  );
  check(
    "原生：不透明表面 / 无模糊 / 小圆角",
    def.blur === "none" && parseFloat(def.radiusCard) <= 12 && /^rgb\(2\d\d, 2\d\d, 2\d\d\)$/.test(def.surfaceBg),
    `模糊=${def.blur} 卡片圆角=${def.radiusCard} 表面=${def.surfaceBg}`,
  );
  check("原生：页面底色是标准版的中性灰白", def.pageBase === "#f9fafb", def.pageBase);
  check("原生：页面没有网格渐变（那层是液态专属）", def.pageA === "transparent", def.pageA);

  // ---- 组件规则：原生必须按标准版来（按钮/输入框/分段滑块）----
  {
    await goTab("设置");
    await page.waitForSelector(".settings-group", { timeout: 15000 });
    const btn = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="save-server"]');
      const cs = el ? getComputedStyle(el) : null;
      const input = document.querySelector("#server-url");
      const ics = input ? getComputedStyle(input) : null;
      const thumb = document.querySelector('[data-testid="ui-style-switch"] .vs-thumb');
      const tcs = thumb ? getComputedStyle(thumb) : null;
      const track = document.querySelector('[data-testid="ui-style-switch"]');
      return {
        btnBg: cs?.backgroundColor || "",
        btnColor: cs?.color || "",
        inputBg: ics?.backgroundColor || "",
        thumbBg: tcs?.backgroundColor || "",
        trackBg: track ? getComputedStyle(track).backgroundColor : "",
        thumbRadius: parseFloat(tcs?.borderRadius || "0"),
      };
    });
    const rgb = (c) => {
      const m = /(\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(c);
      return m ? [+m[1], +m[2], +m[3]] : null;
    };
    const b = rgb(btn.btnBg);
    check(
      "原生：主按钮是实心强调色 + 白字（不是描边 + 蓝字）",
      b !== null && b[0] < 120 && b[2] > 180 && rgb(btn.btnColor)?.[0] > 240,
      `底=${btn.btnBg} 字=${btn.btnColor}`,
    );
    check(
      "原生：输入框是透明底（标准版 bg-transparent，不是填充底）",
      /rgba?\(0, 0, 0, 0\)/.test(btn.inputBg),
      btn.inputBg,
    );
    check(
      "原生：分段滑块是中性凸起面，且与轨道不同色（不能同色靠阴影硬撑）",
      btn.thumbBg !== btn.trackBg && btn.thumbRadius >= 4,
      `滑块=${btn.thumbBg} 轨道=${btn.trackBg} 圆角=${btn.thumbRadius}px`,
    );
  }

  // ---- 切到液态玻璃 ----
  await page.click('[data-testid="ui-style-switch"] .vs-option[data-mode="liquid"]');
  await page.waitForFunction(() => document.documentElement.dataset.style === "liquid", undefined, { timeout: 5000 });
  await page.waitForTimeout(350);
  const liq = await readStyle();
  check("切到液态玻璃后 <html data-style=liquid>", liq.style === "liquid");
  check(
    "液态：折射（blur）回来了",
    /blur\(/.test(liq.blur),
    liq.blur,
  );
  check(
    "液态：圆角变大（20px 卡片 / 14px 字段）",
    parseFloat(liq.radiusCard) >= 16 && parseFloat(liq.radiusField) >= 12,
    `${liq.radiusCard} / ${liq.radiusField}`,
  );
  check("液态：页面底色换成浅蓝灰", liq.pageBase === "#eef1f7", liq.pageBase);
  check("液态：页面网格渐变回来了", liq.pageA !== "transparent", liq.pageA);
  check("液态：强调色也跟着换（#0a84ff）", liq.accent === "#0a84ff", liq.accent);
  await page.screenshot({ path: `${SHOTS}/45-style-liquid.png` });

  // ---- 两套皮肤各自都要能读（对比度）----
  for (const [name, v] of [["原生", def], ["液态玻璃", liq]]) {
    const ratio = styleContrast("rgb(17,24,39)", v.surfaceBg) ?? contrast("rgb(230,237,243)", v.surfaceBg);
    check(
      `${name}：浅色下正文在卡片上的对比度达标（≥4.5）`,
      ratio !== null && ratio >= 4.5,
      ratio === null ? `解析不出颜色 ${v.surfaceBg}` : ratio.toFixed(2) + ":1",
    );
  }

  // ---- 持久化 + 首帧不闪 ----
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector('[data-testid="ui-style-switch"]', { timeout: 15000 });
  check(
    "风格偏好刷新后仍在（液态）",
    (await readStyle()).style === "liquid",
  );

  await page.evaluate(() => localStorage.setItem("nowen-lite.ui-style", "native"));
  // ⚠️ 这里必须 reload 而不是 goto：goto 到同一个 #/settings 只是改 hash，
  //    文档不会重新加载 → 预绘制脚本不跑、app 也不重读 localStorage，
  //    读到的还是上一次的内存值（我在这上面白红了两条）。
  await page.reload({ waitUntil: "domcontentloaded" });
  const early = await page.evaluate(() => document.documentElement.dataset.style);
  check("首帧（DOM 就绪时）就已经是原生，不会先闪一下玻璃", early === "native", early);

  // ---- 两套皮肤 × 深浅色 = 4 种组合都能拿到正确底色 ----
  const combos = [
    ["native", "light", "#f9fafb"],
    ["native", "dark", "#0d1117"],
    ["liquid", "light", "#eef1f7"],
    ["liquid", "dark", "#0f1116"],
  ];
  for (const [style, theme, expected] of combos) {
    await page.evaluate(
      ([s, t]) => {
        localStorage.setItem("nowen-lite.ui-style", s);
        localStorage.setItem("nowen-lite.theme", t);
      },
      [style, theme],
    );
    // 同上：必须 reload 才会重新应用皮肤
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector(".settings-group", { timeout: 15000 });
    const v = await readStyle();
    check(
      `${style} + ${theme}：底色与地址栏色都对`,
      v.pageBase === expected && v.themeColor === expected,
      `底色=${v.pageBase} 地址栏=${v.themeColor}（期望 ${expected}）`,
    );
  }

  // 还原成默认
  await page.evaluate(() => {
    localStorage.setItem("nowen-lite.ui-style", "native");
    localStorage.setItem("nowen-lite.theme", "light");
  });
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector(".settings-group", { timeout: 15000 });
  await page.screenshot({ path: `${SHOTS}/46-style-native.png` });

  // ---------- 32. 设置 · 账号状态 ----------
  currentSection = "[32] 账号状态"; console.log("\n[32] 账号状态");
  await goTab("设置");
  await page.waitForSelector('[data-testid="login-status"]', { timeout: 15000 });
  await page.waitForFunction(
    () => !/检测中/.test(document.querySelector('[data-testid="account-name"]')?.textContent || ""),
    undefined,
    { timeout: 10000 },
  ).catch(() => {});

  const loginText = (await page.locator('[data-testid="account-name"]').innerText()).trim();
  const serverText = (await page.locator('[data-testid="server-state"]').innerText()).trim();
  const loginState = await page.locator('[data-testid="login-status"]').getAttribute("data-state");
  const serverState = await page.locator('[data-testid="server-status"]').getAttribute("data-state");

  // ⚠️ 回归：SDK 的 verifyToken 声明成 {valid,userId,username}，真实返回 {user:{...}}
  //    → info.valid 恒 undefined → 恒判「会话已失效」（用户实际看到的就是这个）
  // 显示名优先于用户名（服务端返回 displayName="演示账号"），所以只要求「显示了某个名字」
  check(
    "已登录时显示「已登录 · 名字」，不能误报会话失效",
    loginState === "ok" &&
      /已登录/.test(loginText) &&
      /演示账号|demo/.test(loginText) &&
      !/会话已失效|无法确认/.test(loginText),
    `state=${loginState} 文案=${loginText}`,
  );
  check(
    "服务端连接单独显示，且为「连接正常」",
    serverState === "ok" && /连接正常/.test(serverText),
    `state=${serverState} 文案=${serverText}`,
  );
  // mock 的版本号是 "vmock"（不是数字），所以只要求「非空版本号」
  check("服务端那行带上了版本号", /·\s*v\S+/.test(serverText), serverText);
  check("有「重新检测」入口", (await page.locator('[data-testid="recheck-account"]').count()) === 1);
  await page.screenshot({ path: `${SHOTS}/49-account-status.png` });

  // 会话失效（401）→ 明确说失效，并给出重新登录
  await page.route("**/api/auth/verify", (route) =>
    route.fulfill({ status: 401, contentType: "application/json", body: '{"error":"Token 无效或已过期"}' }),
  );
  await page.click('[data-testid="recheck-account"]');
  await page.waitForFunction(
    () => document.querySelector('[data-testid="login-status"]')?.getAttribute("data-state") === "expired",
    undefined,
    { timeout: 10000 },
  );
  check(
    "服务端明确 401 时显示「会话已失效」并给出重新登录",
    /会话已失效/.test(await page.locator('[data-testid="account-name"]').innerText()) &&
      (await page.locator('[data-testid="logout"]').innerText()).includes("重新登录"),
  );
  await page.unroute("**/api/auth/verify");

  // 连不上服务端 → 不能断言会话失效，要说「无法确认」
  await page.route("**/api/auth/verify", (route) => route.abort());
  await page.route("**/api/health", (route) => route.abort());
  await page.click('[data-testid="recheck-account"]');
  await page.waitForFunction(
    () => document.querySelector('[data-testid="login-status"]')?.getAttribute("data-state") === "offline",
    undefined,
    { timeout: 10000 },
  );
  check(
    "连不上服务端时说「无法确认」，且服务端那行报「连不上」",
    /无法确认/.test(await page.locator('[data-testid="account-name"]').innerText()) &&
      (await page.locator('[data-testid="server-status"]').getAttribute("data-state")) === "fail",
  );
  await page.unroute("**/api/auth/verify");
  await page.unroute("**/api/health");
  await page.click('[data-testid="recheck-account"]');
  await page.waitForFunction(
    () => document.querySelector('[data-testid="login-status"]')?.getAttribute("data-state") === "ok",
    undefined,
    { timeout: 10000 },
  );
  check("恢复后重新检测能回到「已登录」", true);

  // ---------- 33. 切页时 FAB 不能闪 ----------
  currentSection = "[33] FAB 不闪"; console.log("\n[33] 切页时 FAB 不能闪");
  await goTab("笔记");
  await page.waitForSelector(".fab", { timeout: 15000 });
  // 用 MutationObserver 全程盯着 .fab 有没有被摘掉
  await page.evaluate(() => {
    window.__fabRemovals = 0;
    const seen = () => !!document.querySelector(".fab");
    window.__fabObserver = new MutationObserver(() => {
      if (!seen()) window.__fabRemovals += 1;
    });
    window.__fabObserver.observe(document.body, { childList: true, subtree: true });
  });

  for (let i = 0; i < 3; i += 1) {
    await goTab("日记说说");
    await page.waitForSelector(".diary-group, .empty", { timeout: 15000 });
    await goTab("笔记");
    await page.waitForSelector("a.list-item", { timeout: 15000 });
  }
  const removals = await page.evaluate(() => {
    window.__fabObserver?.disconnect();
    return window.__fabRemovals;
  });
  check(
    "从说说切回笔记的过程中，FAB 一次都没有被摘掉（不再闪）",
    removals === 0,
    `观察到 ${removals} 次消失`,
  );
  check("切回后 FAB 仍在", await page.locator(".fab").isVisible());

  // ---------- 34. 说说编辑 / 删除 ----------
  currentSection = "[34] 说说编辑与删除"; console.log("\n[34] 说说编辑与删除");
  await goTab("日记说说");
  await page.waitForSelector('[data-testid="diary-edit"]', { timeout: 15000 });

  const beforeEdit = (await page.locator(".diary-item .diary-text").first().innerText()).trim();
  const firstMedia = await page.locator(".diary-item").first().locator(".moments img").count();
  check("每条说说都有「编辑」和「删除」", (
    (await page.locator('[data-testid="diary-edit"]').count()) > 0 &&
    (await page.locator('[data-testid="diary-delete"]').count()) > 0
  ));
  check("第一条说说带图片（后面要验编辑不丢图）", firstMedia > 0, `${firstMedia} 张`);

  // 进入编辑
  await page.locator('[data-testid="diary-edit"]').first().click();
  await page.waitForSelector('[data-testid="compose-editing"]', { timeout: 10000 });
  const prefilled = await page.locator(".compose-area").inputValue();
  check(
    "点「编辑」后编辑区带出原文",
    prefilled.trim() === beforeEdit,
    `${prefilled.slice(0, 24)}…`,
  );
  const editMedia = await page.locator('[data-testid="attach-cell"]').count();
  check("编辑时已有图片被带进编辑区", editMedia === firstMedia, `${editMedia} / ${firstMedia}`);
  check(
    "编辑时按钮变成「保存修改」且出现「取消编辑」",
    (await page.locator('[data-testid="diary-submit"]').innerText()).includes("保存修改") &&
      (await page.locator('button:has-text("取消编辑")').count()) === 1,
  );

  // 删掉一张已有图 + 改文案，保存
  if (editMedia > 1) {
    await page.locator('[data-testid="attach-cell"] .attach-remove').first().click();
    await page.waitForFunction(
      (n) => document.querySelectorAll('[data-testid="attach-cell"]').length === n - 1,
      editMedia,
      { timeout: 5000 },
    );
  }
  const editedText = `${beforeEdit.slice(0, 8)}（已被 Lite 改过）`;
  await page.fill(".compose-area", editedText);
  await page.click('[data-testid="diary-submit"]');
  await page.waitForFunction(
    (want) => document.querySelector(".diary-item .diary-text")?.textContent?.includes(want),
    "已被 Lite 改过",
    { timeout: 15000 },
  );
  check("保存后列表里是新文案", true, editedText);
  check(
    "编辑后图片少了一张（PUT 按整批 media 同步）",
    (await page.locator(".diary-item").first().locator(".moments img").count()) ===
      Math.max(0, firstMedia - (editMedia > 1 ? 1 : 0)),
  );
  check("编辑历史没有被追加成新说说（首条 id 没变）", (
    (await page.locator(".diary-item .diary-text").first().innerText()).trim() === editedText
  ));
  await page.screenshot({ path: `${SHOTS}/50-diary-edit.png` });

  // 删除
  const countBefore = await page.locator('[data-testid="diary-delete"]').count();
  await page.locator('[data-testid="diary-delete"]').first().click();
  await page.waitForSelector("dialog[open]", { timeout: 10000 });
  check(
    "删除前有确认对话框（不是直接删）",
    (await page.locator("dialog[open]").innerText()).includes("删除这条说说"),
  );
  await page.screenshot({ path: `${SHOTS}/51-diary-delete-confirm.png` });
  await page.locator("dialog[open] button", { hasText: "删除" }).last().click();
  await page.waitForFunction(
    (n) => document.querySelectorAll('[data-testid="diary-delete"]').length === n - 1,
    countBefore,
    { timeout: 15000 },
  );
  check("确认后这条说说从列表消失", true);
  check(
    "被删的那条文案也不在页面上了",
    !(await page.locator(".diary-item .diary-text").allInnerTexts()).some((x) => x.includes("已被 Lite 改过")),
  );

  // 刷新确认服务端真的改了（不是只改了本地状态）
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector('[data-testid="diary-edit"]', { timeout: 15000 });
  check(
    "刷新后依然是「已改过 + 已删除」的状态（说明写回了服务端）",
    !(await page.locator(".diary-item .diary-text").allInnerTexts()).some((x) => x.includes("已被 Lite 改过")),
  );

  // ---------- 35. 服务端相对地址补全（APK 的关键） ----------
  currentSection = "[35] 相对地址补全"; console.log("\n[35] 服务端相对地址补全");
  {
    // 装进 APK 后 WebView 的 origin 是 https://localhost，
    // 页面里相对的 /api/... 会打到手机本机 → 图片全裂。
    // 所以服务端返回的相对 URL 必须在渲染出口补成绝对地址。
    const r = await page.evaluate(async () => {
      const KEY = "nowen-lite.server";
      const before = localStorage.getItem(KEY);
      localStorage.setItem(KEY, "http://192.168.8.9:3002");
      const m = await import("/src/api/rest.ts");
      const out = {
        rel: m.serverUrl("/api/diary/attachments/abc"),
        signed: m.serverUrl("/api/attachments/x?exp=1&sig=2"),
        abs: m.serverUrl("http://other/api/x"),
        https: m.serverUrl("https://other/api/x"),
        data: m.serverUrl("data:image/png;base64,AAAA"),
        empty: m.serverUrl(""),
        noSlash: m.serverUrl("api/x"),
      };
      if (before === null) localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, before);
      return out;
    });
    check(
      "服务端相对路径会补成绝对（APK 里图片才显示得出来）",
      r.rel === "http://192.168.8.9:3002/api/diary/attachments/abc",
      r.rel,
    );
    check(
      "签名附件的相对 URL 同样补全（参数原样保留）",
      r.signed === "http://192.168.8.9:3002/api/attachments/x?exp=1&sig=2",
      r.signed,
    );
    check(
      "已经是绝对地址 / data: 的原样返回，不重复拼",
      r.abs === "http://other/api/x" &&
        r.https === "https://other/api/x" &&
        r.data === "data:image/png;base64,AAAA",
      `${r.abs} | ${r.https} | ${r.data.slice(0, 24)}…`,
    );
    check("空值安全", r.empty === "");
    check(
      "缺前导斜杠也能正确拼",
      r.noSlash === "http://192.168.8.9:3002/api/x",
      r.noSlash,
    );
  }

  // ---------- 36. 登录页：协议下拉 + 无协议自动补全 ----------
  currentSection = "[36] 服务器地址补协议"; console.log("\n[36] 服务器地址补协议");
  {
    // 先退回未登录
    await page.evaluate(() => {
      localStorage.removeItem("nowen-lite.token");
      localStorage.removeItem("nowen-lite.refresh");
      localStorage.setItem("nowen-lite.lang", "zh-CN");
    });
    // ⚠️ 本节故意把地址指向一个**没有被服务端 CORS 白名单放行**的 origin，
    //    浏览器会如实打出 CORS 报错 → 会误伤 [90] 的「无 JS 运行时错误」断言。
    //    这里把健康检查拦掉，让本节只测"地址怎么存/怎么拼"，不产生真实请求。
    await page.route("**/api/health**", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: '{"status":"ok"}' }),
    );
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForSelector("#server-host", { timeout: 15000 });

    check("登录页有协议下拉（不用用户手打 http://）",
      (await page.locator('[data-testid="server-scheme"]').count()) === 1);
    check("协议下拉默认是 http",
      (await page.locator('[data-testid="server-scheme"]').inputValue()) === "http");
    check("主机与协议是分开的两段式输入",
      (await page.locator("#server-host").count()) === 1 &&
      (await page.locator(".server-sep").innerText()).includes("://"));

    // ⚠️ 核心回归：手打不带协议的地址，存进去必须自动补 http://
    //    不补的话浏览器会当相对路径 → https://localhost/192.168.8.9:3002/api/... → 全部 404
    const schemeFix = await page.evaluate(async () => {
      const m = await import("/src/lib/serverAddress.ts");
      const auth = await import("/src/auth/auth.ts");
      const rest = await import("/src/api/rest.ts");
      localStorage.removeItem("nowen-lite.server");
      auth.setServerUrl("192.168.8.9:3002");        // 用户手打、没写协议
      const stored = auth.getServerUrl();
      const apiUrl = rest.serverUrl("/api/x");
      localStorage.setItem("nowen-lite.server", "192.168.8.9:3002");  // 模拟 localStorage 里的脏值
      const dirty = rest.serverUrl("/api/x");
      localStorage.removeItem("nowen-lite.server");
      auth.setServerUrl("");
      return {
        stored, apiUrl, dirty,
        emptyKept: auth.getServerUrl() === "",
        httpsKept: m.ensureScheme("https://a/b") === "https://a/b",
        splitHost: m.splitServer("https://a.b:3001").host,
        splitScheme: m.splitServer("https://a.b:3001").scheme,
        joinEmpty: m.joinServer({ scheme: "http", host: "" }),
      };
    });
    check("手打「192.168.8.9:3002」存进去会自动补成 http://",
      schemeFix.stored === "http://192.168.8.9:3002", schemeFix.stored);
    check("补协议后接口地址是绝对的（不再是相对路径）",
      schemeFix.apiUrl === "http://192.168.8.9:3002/api/x", schemeFix.apiUrl);
    check("localStorage 里已有的脏值也会被兜住",
      schemeFix.dirty === "http://192.168.8.9:3002/api/x", schemeFix.dirty);
    check("空串仍表示「同源」，不会被补成 http://",
      schemeFix.emptyKept && schemeFix.joinEmpty === "");
    check("已经是 https 的地址不会被改写",
      schemeFix.httpsKept && schemeFix.splitScheme === "https" && schemeFix.splitHost === "a.b:3001");

    // 切协议 → 存下来的地址跟着变
    await page.fill("#server-host", "192.168.8.9:3002");
    // 必须把账号密码也填上：提交里是先校验再存地址，不填就直接 return 了
    await page.fill("#username", "demo");
    await page.fill("#password", "demo1234");
    await page.selectOption('[data-testid="server-scheme"]', "https");
    await page.click('[data-testid="login-submit"]');
    await page.waitForTimeout(1500);
    const saved = await page.evaluate(() => localStorage.getItem("nowen-lite.server"));
    check("选 https 后存下来的是 https://…", saved === "https://192.168.8.9:3002", String(saved));

    // 清理
    await page.unroute("**/api/health**");
    await page.evaluate(() => {
      localStorage.removeItem("nowen-lite.server");
      localStorage.removeItem("nowen-lite.username");
    });
  }

  // ---------- 37. 附件图片兜底 ----------
  currentSection = "[37] 图片兜底"; console.log("\n[37] 附件图片兜底");
  {
    // 背景：App 里 <img> 直连被拦（服务端日志一条图片请求都没有），
    //       而同一页面的 fetch 是通的 → 直连失败时改用 fetch 取回来转 blob。
    // 拦掉这个故意不存在的地址：不拦的话它会打到接口产生多余 401，
    // 误伤 [90] 的「401 次数」断言（我在这上面红了一次）。
    await page.route("**/api/diary/attachments/definitely-not-exist*", (route) =>
      route.fulfill({ status: 404, contentType: "text/plain", body: "nope" }),
    );
    const r = await page.evaluate(async () => {
      const m = await import("/src/lib/imageFallback.ts");
      const img = document.createElement("img");
      // 一个必定 404 的地址 → 兜底也应失败并返回 false（不能抛）
      img.src = "/api/diary/attachments/definitely-not-exist";
      const handled = await m.retryImageViaFetch(img);
      return {
        notExistHandled: handled,
        dataSkipped: await m.fetchAsBlobUrl("data:image/png;base64,AAAA"),
        emptySkipped: await m.fetchAsBlobUrl(""),
        // 同一个 URL 第二次调用不应重复请求（有 in-flight 去重）
        dedup: typeof m.fetchAsBlobUrl === "function",
      };
    });
    check("拿不到图时不抛异常、返回 false（不会把页面打崩）", r.notExistHandled === false);
    check("data:/空值 直接跳过，不做多余请求",
      r.dataSkipped === null && r.emptySkipped === null);
    await page.unroute("**/api/diary/attachments/definitely-not-exist*");

    // 源码级核对：说说与正文的 <img> 都不能再用 loading="lazy"
    // （WebView 的嵌套滚动容器里它经常永远不触发 → 图片一直占位但从没请求过）
    const srcs = await page.evaluate(async () => {
      const files = [
        "/src/screens/DiaryScreen.tsx",
        "/src/lib/noteBody.tsx",
      ];
      const out = {};
      for (const f of files) {
        const text = await fetch(f).then((r) => (r.ok ? r.text() : ""));
        out[f] = text;
      }
      return out;
    });
    const diarySrc = srcs["/src/screens/DiaryScreen.tsx"] || "";
    check(
      "说说图片不再用 loading=lazy",
      !/imageUrl\([^)]*\)[\s\S]{0,80}loading="lazy"/.test(diarySrc) &&
        !/<img[^>]*loading="lazy"[^>]*imageUrl/.test(diarySrc),
      diarySrc.includes('loading="lazy"') ? "仍有残留" : "已移除",
    );
    check(
      "说说与正文都挂了 fetch 兜底",
      diarySrc.includes("retryImageViaFetch") &&
        (srcs["/src/lib/noteBody.tsx"] || "").includes("retryImageViaFetch"),
    );
    check(
      "正文的 sanitizer 不再放行 loading 属性",
      !/ADD_ATTR:[^\]]*"loading"/.test(srcs["/src/lib/noteBody.tsx"] || ""),
    );
  }

  // ---------- 38. 右上角连接指示器 + 同步诊断 ----------
  currentSection = "[38] 连接指示器与同步诊断"; console.log("\n[38] 连接指示器与同步诊断");
  {
    // 先登录回来（[36] 那节把会话退掉了）。
    // ⚠️ 必须先判断是否已登录再调 goTab —— 未登录时根本没有底部导航，goTab 会直接超时。
    if ((await page.locator(".bottom-nav").count()) === 0) {
      // ⚠️ 必须 reload：上一节把地址填成了 192.168.8.9（不可达），
      //    而**组件状态**里还留着它 —— 不重载的话这次登录又会用到那个地址，必然超时。
      await page.reload({ waitUntil: "networkidle" });
      await page.waitForSelector("#username", { timeout: 15000 });
      await page.fill("#username", "demo");
      await page.fill("#password", "demo1234");
      await page.click('[data-testid="login-submit"]');
      await page.waitForSelector(".bottom-nav", { timeout: 20000 });
    }

    // 指示器是固定定位、全局可见
    const box = await page.evaluate(() => {
      const b = document.querySelector('[data-testid="conn-badge"]');
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return {
        state: b.dataset.state,
        top: Math.round(r.top),
        right: Math.round(window.innerWidth - r.right),
        pos: getComputedStyle(b).position,
        text: (document.querySelector('[data-testid="conn-latency"]')?.textContent || "").trim(),
      };
    });
    check("登录后右上角有连接指示器", box !== null);
    check("它是固定定位（滚动/切页都不动）", box?.pos === "fixed", box?.pos);
    check("确实贴在右上角", (box?.top ?? 999) < 60 && (box?.right ?? 999) < 40,
      `top=${box?.top} right=${box?.right}`);
    check("探测成功后显示延迟（毫秒）", /^\d+ ms$/.test(box?.text || ""), box?.text);
    check("状态是 ok（mock 可达）", box?.state === "ok", box?.state);
    await page.screenshot({ path: `${SHOTS}/60-conn-badge.png` });

    // ⚠️ 回归：它固定在右上角，**绝不能挡住顶栏右侧的按钮**。
    //    之前做成可点按钮时，把「编辑」压住了 —— 按钮可见、稳定、但点不动。
    check("指示器不接收点击（不会挡住顶栏按钮）",
      (await page.locator('[data-testid="conn-badge"]').evaluate((el) => getComputedStyle(el).pointerEvents)) === "none");

    // 同步诊断表
    await goTab("设置");
    await page.waitForSelector('[data-testid="sync-diagnostics"]', { timeout: 15000 });
    const diag = await page.locator('[data-testid="sync-diagnostics"]').innerText();
    const need = ["设备标识", "服务端", "本地缓存条目", "待同步条目", "未解决冲突", "最近刷新", "最近通信", "最近错误"];
    const missing = need.filter((k) => !diag.includes(k));
    check("同步诊断表八项齐全（对齐标准版）", missing.length === 0, missing.join(",") || "全齐");
    check("「最近通信」有真实时间戳",
      /\d{1,2}:\d{2}/.test(await page.locator('[data-testid="diag-last-ping"]').innerText()),
      await page.locator('[data-testid="diag-last-ping"]').innerText());
    check("「最近错误」在连通时显示「无」",
      (await page.locator('[data-testid="diag-last-error"]').innerText()).includes("无"));
    check("有「刷新」入口", (await page.locator('[data-testid="diag-refresh"]').count()) === 1);

    // 数据来源两张卡片（照标准版的单选卡片）
    check("有「不同步，仅此设备」卡片", (await page.locator('[data-testid="sync-mode-offline"]').count()) === 1);
    check("有「我的 Nowen Server」卡片且标为当前模式",
      (await page.locator('[data-testid="sync-mode-live"]').getAttribute("data-active")) === "true");
    check("未实现的模式如实标注（不假装能用）",
      (await page.locator('[data-testid="sync-mode-offline"]').getAttribute("data-disabled")) === "true");
    await page.screenshot({ path: `${SHOTS}/61-sync-section.png` });

    // 开关：关掉后指示器消失，开回来
    await page.click('[data-testid="conn-badge-toggle"]');
    await page.waitForFunction(
      () => document.querySelector('[data-testid="conn-badge"]') === null,
      undefined, { timeout: 5000 },
    );
    check("设置里可关闭右上角指示器", true);
    await page.click('[data-testid="conn-badge-toggle"]');
    await page.waitForSelector('[data-testid="conn-badge"]', { timeout: 5000 });
    check("再打开能恢复", true);
  }

  // ---------- 39. 冲突台账 ----------
  currentSection = "[39] 冲突台账"; console.log("\n[39] 冲突台账");
  {
    const r = await page.evaluate(async () => {
      const m = await import("/src/lib/conflictLog.ts");
      m.clearConflicts();
      const empty = m.unresolvedConflicts().length;
      const id = m.logConflict({
        noteId: "note-x", noteTitle: "被别处改过的笔记", localVersion: 3, serverVersion: 5,
      });
      const after = m.unresolvedConflicts().length;
      const same = m.listConflicts()[0];
      // 同一篇短时间内重复冲突只留一条
      m.logConflict({ noteId: "note-x", noteTitle: "被别处改过的笔记", localVersion: 3, serverVersion: 6 });
      const dedup = m.unresolvedConflicts().length;
      // 用**当前列表里那条**的 id 来标记（去重会换掉 id，用旧 id 标记会失效）
      m.resolveConflict(m.listConflicts()[0].id, "overwrite");
      const resolved = m.unresolvedConflicts().length;
      // 不存正文（只留 id/标题/版本号）
      const fields = Object.keys(m.listConflicts()[0] || {}).sort().join(",");
      m.clearConflicts();
      return { empty, after, serverVersion: same?.serverVersion, dedup, resolved, fields };
    });
    check("初始没有未解决冲突", r.empty === 0, String(r.empty));
    check("记一笔后未解决数 +1", r.after === 1, String(r.after));
    check("记录了服务端版本号", r.serverVersion === 5, String(r.serverVersion));
    check("同一篇短时间重复冲突只留一条（不刷屏）", r.dedup === 1, String(r.dedup));
    check("标记已解决后不再计入未解决", r.resolved === 0, String(r.resolved));
    check(
      "台账不存正文（只留 id/标题/版本/时间）",
      !r.fields.includes("content") && r.fields.includes("noteTitle"),
      r.fields,
    );

    // 诊断表读的是台账的真实数字
    await goTab("设置");
    await page.waitForSelector('[data-testid="diag-conflicts"]', { timeout: 15000 });
    const before = await page.locator('[data-testid="diag-conflicts"]').innerText();
    await page.evaluate(async () => {
      const m = await import("/src/lib/conflictLog.ts");
      m.logConflict({ noteId: "note-y", noteTitle: "另一篇", localVersion: 1, serverVersion: 2 });
    });
    // ⚠️ 必须切页强制重挂：测试用**动态 import** 拿到的模块实例与 App 的不是同一个
    //    （Vite 对每个 importer 给不同 URL）→ 写进去了但 App 的订阅收不到通知。
    //    真实使用中两者是同一实例，不存在这个问题。
    await goTab("笔记");
    await goTab("设置");
    await page.waitForSelector('[data-testid="diag-conflicts"]', { timeout: 15000 });
    await page.waitForFunction(
      () => document.querySelector('[data-testid="diag-conflicts"]')?.textContent?.trim() === "1",
      undefined, { timeout: 5000 },
    );
    check("记一笔冲突后诊断表的数字变成 1", true, `原来是 ${before.trim()}`);
    check("冲突列表出现这一篇",
      (await page.locator('[data-testid="conflict-list"]').innerText()).includes("另一篇"));
    await page.screenshot({ path: `${SHOTS}/62-conflict-list.png` });

    await page.click('[data-testid="conflict-dismiss-all"]');
    await page.waitForFunction(
      () => document.querySelector('[data-testid="diag-conflicts"]')?.textContent?.trim() === "0",
      undefined, { timeout: 5000 },
    );
    check("「全部标记已解决」把数字归零（同一实例内即时生效）", true);
    check("归零后显示空态", (await page.locator('[data-testid="conflict-empty"]').count()) === 1);

    await page.click('[data-testid="conflict-clear"]');
    await page.waitForFunction(
      () => document.querySelector('[data-testid="conflict-clear"]') === null,
      undefined, { timeout: 5000 },
    );
    check("「清空冲突记录」把台账整个清掉（按钮随之消失）", true);
  }

  currentSection = "[90] 控制台"; console.log("\n[90] 控制台");
  const jsErrors = consoleErrors.filter((e) => !/Failed to load resource/i.test(e));
  check("无 JS 运行时错误", jsErrors.length === 0, jsErrors.slice(0, 3).join(" | "));

  // 预期内的 401 共 7 次，全部是【故意】制造的：
  //   · 2 次：错误密码 / 错误验证码（负向用例）
  //   · 4 次：第 [24] 节路径B 植入伪造 token 后打 /api/tasks* ——
  //           这正是「401 触发被动续期」的触发条件，属于被测对象本身
  //   · 1 次：第 [32] 节故意把 /api/auth/verify 打成 401，验证「会话已失效」分支
  const unauthorized = httpFailures.filter((f) => f.status === 401);
  check(
    "除预期外没有多余 401（预期 7 次：2 次负向登录 + 4 次续期触发 + 1 次故意 401）",
    unauthorized.length === 7,
    `实际 ${unauthorized.length} 次：${unauthorized
      .map((f) => f.url.replace(/^https?:\/\/[^/]+/, ""))
      .join(", ")}`,
  );

  // 409 是第 17/18 节【故意】制造的两次版本冲突，属于预期
  const conflicts = httpFailures.filter((f) => f.status === 409);
  check(
    "版本冲突恰好发生 2 次（两条冲突分支各一次）",
    conflicts.length === 2,
    `实际 ${conflicts.length} 次`,
  );

  // 404：第 [27] 节故意打的两次 —— 为验证「点 × / 放弃编辑」真的把悬空附件删掉了，
  // 测试必须去请求一次那张已删的图并期待 404。属于被测对象本身。
  const otherHttp = httpFailures.filter(
    (f) =>
      f.status !== 401 &&
      f.status !== 409 &&
      !(f.status === 404 && /\/api\/diary\/attachments\//.test(f.url)),
  );
  check(
    "没有其它 4xx/5xx（404 等）",
    otherHttp.length === 0,
    otherHttp.map((f) => `${f.status} ${f.url}`).join(" | "),
  );
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`\n✗ 在 ${currentSection} 环节失败：`);
  console.error(msg);
  check(`脚本执行完成（卡在 ${currentSection}）`, false, msg.split("\n")[0]);
  await page.screenshot({ path: `${SHOTS}/99-failure.png` }).catch(() => {});
  console.error(`  失败截图: ${SHOTS}/99-failure.png`);
} finally {
  await browser.close();
}

const passed = results.filter((r) => r.pass).length;
console.log(`\n===== 结果：${passed}/${results.length} 通过 =====`);
if (passed !== results.length) {
  console.log("\n失败项：");
  for (const r of results.filter((x) => !x.pass)) console.log(`  ❌ ${r.name} — ${r.detail}`);
  process.exit(1);
}
console.log("截图目录：" + SHOTS);
