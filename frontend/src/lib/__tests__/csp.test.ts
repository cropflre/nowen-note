import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.resolve(testDir, "../../../index.html"), "utf8");

describe("index.html CSP", () => {
  it("允许客户端 fetch 外部 http/https 服务端", () => {
    const csp = html.match(/Content-Security-Policy"\s+content="([\s\S]*?)"/)?.[1] || "";
    expect(csp).toMatch(/connect-src[^;]*\bhttp:\s+https:/);
  });
});
