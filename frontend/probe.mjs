import { chromium } from "playwright-core";

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const URL = process.env.PROBE_URL || "http://127.0.0.1:5199/";

const consoleMsgs = [];
const pageErrors = [];
const failedReqs = [];

const browser = await chromium.launch({
  executablePath: EDGE,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-proxy-server"],
});
const page = await browser.newPage();

page.on("console", (msg) => {
  consoleMsgs.push(`[${msg.type()}] ${msg.text()}`);
});
page.on("pageerror", (err) => {
  pageErrors.push(`${err.name}: ${err.message}\n${err.stack || ""}`);
});
page.on("requestfailed", (req) => {
  // skip favicon / mDNS / non-critical
  if (!req.url().includes("favicon") && !req.url().includes("mdns"))
    failedReqs.push(`${req.method()} ${req.url()} -> ${req.failure()?.errorText}`);
});

console.log("=== NAVIGATING ===", URL);
try {
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 20000 });
} catch (e) {
  console.log("goto error:", e.message);
}

// give the SPA time to mount / render
await page.waitForTimeout(8000);

const finalUrl = page.url();
const rootHtml = await page.evaluate(() => {
  const r = document.getElementById("root");
  return r ? r.innerHTML.slice(0, 500) : "NO #root";
});
const bodyText = (await page.evaluate(() => document.body?.innerText || "")).slice(0, 400);

await page.screenshot({ path: "probe-shot2.png", fullPage: false });

console.log("\n=== FINAL URL ===\n" + finalUrl);
console.log("\n=== #root innerHTML (first 500) ===\n" + rootHtml);
console.log("\n=== BODY TEXT (first 400) ===\n" + bodyText);
console.log("\n=== PAGE ERRORS (" + pageErrors.length + ") ===");
pageErrors.forEach((e) => console.log("---\n" + e));
console.log("\n=== CONSOLE ERRORS ONLY ===");
consoleMsgs.filter(m => m.includes("[error]") || m.includes("[warning]")).forEach(m => console.log(m));
console.log("\n=== FAILED REQUESTS (" + failedReqs.length + ") ===");
failedReqs.forEach((r) => console.log(r));

await browser.close();
