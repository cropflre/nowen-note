import { describe, it, expect } from "vitest";
import { normalizeServerBaseUrl, isValidServerUrl, buildServerUrl, parseServerUrl } from "../serverUrl";

// =====================================================================
//  normalizeServerBaseUrl
// =====================================================================
describe("normalizeServerBaseUrl", () => {
  // --- 基本 URL ---
  it("保留完整 URL 不变", () => {
    expect(normalizeServerBaseUrl("https://fnos.net/user:3001")).toBe("https://fnos.net/user:3001");
  });

  it("去掉末尾斜杠", () => {
    expect(normalizeServerBaseUrl("https://fnos.net/user:3001/")).toBe("https://fnos.net/user:3001");
  });

  it("去掉末尾多层斜杠", () => {
    expect(normalizeServerBaseUrl("https://fnos.net/user:3001///")).toBe("https://fnos.net/user:3001");
  });

  // --- API 子路径剥离 ---
  it("剥离 /api/health 后缀", () => {
    expect(normalizeServerBaseUrl("https://fnos.net/user:3001/api/health")).toBe("https://fnos.net/user:3001");
  });

  it("剥离 /api/version 后缀", () => {
    expect(normalizeServerBaseUrl("https://fnos.net/user:3001/api/version")).toBe("https://fnos.net/user:3001");
  });

  it("剥离 /api/auth/login 后缀", () => {
    expect(normalizeServerBaseUrl("https://fnos.net/user:3001/api/auth/login")).toBe("https://fnos.net/user:3001");
  });

  it("剥离单独的 /api 后缀", () => {
    expect(normalizeServerBaseUrl("https://example.com/api")).toBe("https://example.com");
  });

  it("剥离 /api 带末尾斜杠", () => {
    expect(normalizeServerBaseUrl("https://example.com/api/")).toBe("https://example.com");
  });

  it("剥离无 path 前缀的 /api/health", () => {
    expect(normalizeServerBaseUrl("https://example.com/api/health")).toBe("https://example.com");
  });

  // --- 不误删 ---
  it("不误删 /api-gateway", () => {
    expect(normalizeServerBaseUrl("https://example.com/api-gateway")).toBe("https://example.com/api-gateway");
  });

  it("不误删 /my-api", () => {
    expect(normalizeServerBaseUrl("https://example.com/my-api")).toBe("https://example.com/my-api");
  });

  it("不误删 /user:3001", () => {
    expect(normalizeServerBaseUrl("https://fnos.net/user:3001")).toBe("https://fnos.net/user:3001");
  });

  it("不误删 /user:3001/dashboard", () => {
    expect(normalizeServerBaseUrl("https://fnos.net/user:3001/dashboard")).toBe("https://fnos.net/user:3001/dashboard");
  });

  // --- 纯 IP / host:port ---
  it("纯 IP 加默认 http", () => {
    expect(normalizeServerBaseUrl("192.168.1.10:3001")).toBe("http://192.168.1.10:3001");
  });

  it("纯域名加默认 http", () => {
    expect(normalizeServerBaseUrl("fnos.net/user:3001")).toBe("http://fnos.net/user:3001");
  });

  it("无端口 IP", () => {
    expect(normalizeServerBaseUrl("192.168.1.10")).toBe("http://192.168.1.10");
  });

  it("完整 http URL", () => {
    expect(normalizeServerBaseUrl("http://192.168.1.10:3001")).toBe("http://192.168.1.10:3001");
  });

  it("完整 https URL", () => {
    expect(normalizeServerBaseUrl("https://example.com")).toBe("https://example.com");
  });

  it("https 带端口", () => {
    expect(normalizeServerBaseUrl("https://example.com:3001")).toBe("https://example.com:3001");
  });

  // --- 非法输入 ---
  it("空字符串返回空", () => {
    expect(normalizeServerBaseUrl("")).toBe("");
  });

  it("null 返回空", () => {
    expect(normalizeServerBaseUrl(null)).toBe("");
  });

  it("undefined 返回空", () => {
    expect(normalizeServerBaseUrl(undefined)).toBe("");
  });

  it('"null" 字符串返回空', () => {
    expect(normalizeServerBaseUrl("null")).toBe("");
  });

  it('"file://" 返回空', () => {
    expect(normalizeServerBaseUrl("file://")).toBe("");
  });

  it('"file:///path" 返回空', () => {
    expect(normalizeServerBaseUrl("file:///C:/Users/test")).toBe("");
  });

  it("纯空白返回空", () => {
    expect(normalizeServerBaseUrl("   ")).toBe("");
  });

  // --- 带前后空白 ---
  it("trim 前后空白", () => {
    expect(normalizeServerBaseUrl("  https://fnos.net/user:3001  ")).toBe("https://fnos.net/user:3001");
  });
});

// =====================================================================
//  isValidServerUrl
// =====================================================================
describe("isValidServerUrl", () => {
  it("合法 URL 返回 true", () => {
    expect(isValidServerUrl("https://fnos.net/user:3001")).toBe(true);
  });

  it("非法值返回 false", () => {
    expect(isValidServerUrl("null")).toBe(false);
    expect(isValidServerUrl("")).toBe(false);
    expect(isValidServerUrl(null)).toBe(false);
    expect(isValidServerUrl("file://")).toBe(false);
  });
});

// =====================================================================
//  WebSocket URL 推导（验证从 serverBaseUrl 能正确拼出 ws URL）
// =====================================================================
describe("WebSocket URL from serverBaseUrl", () => {
  function toWsUrl(serverBaseUrl: string, token: string): string {
    const wsOrigin = serverBaseUrl.replace(/^http/, "ws");
    return `${wsOrigin}/ws?token=${encodeURIComponent(token)}`;
  }

  it("fnOS 反代路径", () => {
    expect(toWsUrl("https://fnos.net/user:3001", "abc123")).toBe(
      "wss://fnos.net/user:3001/ws?token=abc123"
    );
  });

  it("局域网 IP", () => {
    expect(toWsUrl("http://192.168.1.10:3001", "abc123")).toBe(
      "ws://192.168.1.10:3001/ws?token=abc123"
    );
  });

  it("无端口 https", () => {
    expect(toWsUrl("https://example.com", "abc123")).toBe(
      "wss://example.com/ws?token=abc123"
    );
  });
});

// =====================================================================
//  旧 API 向后兼容
// =====================================================================
describe("parseServerUrl (legacy)", () => {
  it("解析完整 URL 返回三段", () => {
    const parts = parseServerUrl("https://fnos.net:3001");
    expect(parts.protocol).toBe("https");
    expect(parts.host).toBe("fnos.net");
    expect(parts.port).toBe("3001");
  });

  it("无端口时 port 为空", () => {
    const parts = parseServerUrl("https://example.com");
    expect(parts.port).toBe("");
  });

  it("无 scheme 默认 http", () => {
    const parts = parseServerUrl("192.168.1.10:3001");
    expect(parts.protocol).toBe("http");
    expect(parts.host).toBe("192.168.1.10");
    expect(parts.port).toBe("3001");
  });
});

describe("buildServerUrl (legacy)", () => {
  it("拼接三段为 URL", () => {
    expect(buildServerUrl({ protocol: "https", host: "fnos.net", port: "3001", path: "" })).toBe("https://fnos.net:3001");
  });

  it("无端口时不拼", () => {
    expect(buildServerUrl({ protocol: "http", host: "192.168.1.10", port: "", path: "" })).toBe("http://192.168.1.10");
  });

  it("带 path 前缀", () => {
    expect(buildServerUrl({ protocol: "https", host: "fnos.net", port: "", path: "/user:3001" })).toBe("https://fnos.net/user:3001");
  });
});

describe("API endpoint construction", () => {
  it("为外部 HTTP 服务正确拼出 /api/health", () => {
    const baseUrl = normalizeServerBaseUrl("http://note.nowen.cn");
    expect(`${baseUrl}/api/health`).toBe("http://note.nowen.cn/api/health");
  });
});

