import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("登录页记住账号密码", () => {
  it("回填安全存储，并在普通登录和两步验证成功后保存", () => {
    const source = fs.readFileSync(
      path.resolve(process.cwd(), "src/components/LoginPage.tsx"),
      "utf8",
    );

    expect(source).toContain("loadRememberedCredentials()");
    expect(source).toContain('type="checkbox"');
    expect(source).toContain('t("auth.rememberMe")');
    expect(source.match(/await persistRememberedLogin\(baseUrl \|\| ""\)/g)).toHaveLength(2);
  });
});
