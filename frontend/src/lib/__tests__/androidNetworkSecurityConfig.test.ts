import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function readAndroidMain(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), "android/app/src/main", relativePath), "utf8");
}

describe("Android 网络安全配置", () => {
  it("Manifest 引用网络安全配置", () => {
    expect(readAndroidMain("AndroidManifest.xml"))
      .toContain('android:networkSecurityConfig="@xml/network_security_config"');
  });

  it("保留局域网 HTTP，并信任系统证书和用户安装的 CA", () => {
    const config = readAndroidMain("res/xml/network_security_config.xml");
    // 声明配置文件后 Android 7.0+ 忽略 usesCleartextTraffic，漏掉这一项会让所有 http:// 服务器连不上。
    expect(config).toMatch(/<base-config\s+cleartextTrafficPermitted="true"\s*>/);
    expect(config).toContain('<certificates src="system" />');
    expect(config).toContain('<certificates src="user" />');
  });
});
