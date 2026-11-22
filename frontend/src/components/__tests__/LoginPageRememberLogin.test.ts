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
    // 普通登录和两步验证成功都经过同一个 completeLogin，在保存令牌前保存记住的账号。
    const completeLogin = source.slice(source.indexOf("const completeLogin = async"), source.indexOf("const handleSubmit = async"));
    expect(completeLogin).toContain("await persistRememberedLogin(baseUrl)");
    expect(completeLogin.indexOf("persistRememberedLogin")).toBeLessThan(completeLogin.indexOf("storeAuthTokens"));
    expect(source.match(/await completeLogin\(/g)).toHaveLength(2);
  });
});
