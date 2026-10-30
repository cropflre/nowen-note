import type { LoginResult, NowenConfig } from "./types.js";

export class TwoFactorRequiredError extends Error {
  constructor(readonly result: Extract<LoginResult, { requires2FA: true }>) {
    super("需要两步验证：请调用 verifyTwoFactor(ticket, code)");
    this.name = "TwoFactorRequiredError";
  }
}

/** Shared authentication for REST and attachment requests. */
export class NowenAuth {
  private username: string;
  private password: string;
  private token: string | null = null;
  private challenge: Extract<LoginResult, { requires2FA: true }> | null = null;
  private loginPromise: Promise<LoginResult> | null = null;
  private revision = 0;
  private identityRevision = 0;
  private readonly baseUrl: string;
  private readonly timeout: number;
  private readonly fetchImpl: typeof fetch;

  constructor(config: NowenConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.username = config.username || "";
    this.password = config.password || "";
    this.timeout = config.timeout || 30_000;
    this.fetchImpl = config.fetch || globalThis.fetch.bind(globalThis);
  }

  login(username = this.username, password = this.password): Promise<LoginResult> {
    ++this.identityRevision;
    return this.startLogin(username, password);
  }

  private async startLogin(username: string, password: string): Promise<LoginResult> {
    const revision = ++this.revision;
    this.token = null;
    this.challenge = null;
    this.username = username;
    this.password = password;
    const promise = this.performLogin(username, password, revision);
    this.loginPromise = promise;
    try {
      return await promise;
    } finally {
      if (this.loginPromise === promise) this.loginPromise = null;
    }
  }

  private async performLogin(username: string, password: string, revision: number): Promise<LoginResult> {
    const data = await this.post("/api/auth/login", { username, password });
    this.assertRevision(revision);
    if (data.requires2FA) {
      if (!data.ticket) throw new Error("登录响应缺少两步验证 ticket");
      this.challenge = { requires2FA: true, ticket: data.ticket, username: data.username || username };
      return this.challenge;
    }
    if (!data.token) throw new Error("登录响应缺少 token");
    this.token = data.token;
    return { requires2FA: false, token: data.token };
  }

  async verifyTwoFactor(ticket: string, code: string): Promise<{ token: string }> {
    if (!this.challenge || this.challenge.ticket !== ticket) {
      throw new Error("两步验证 ticket 不属于当前登录，请重新登录");
    }
    const revision = this.revision;
    const data = await this.post("/api/auth/2fa/verify", { ticket, code });
    this.assertRevision(revision);
    if (!data.token) throw new Error("两步验证响应缺少 token");
    ++this.revision;
    this.token = data.token;
    this.challenge = null;
    return { token: data.token };
  }

  setToken(token: string | null): void {
    ++this.revision;
    ++this.identityRevision;
    this.token = token;
    this.challenge = null;
    this.loginPromise = null;
    // An externally supplied token must never fall back to another account's credentials.
    this.username = "";
    this.password = "";
  }

  getToken(): string | null {
    return this.token;
  }

  async ensureToken(): Promise<string> {
    if (this.token) return this.token;
    if (this.challenge) throw new TwoFactorRequiredError(this.challenge);
    if (!this.loginPromise && (!this.username || !this.password)) {
      throw new Error("未登录：请调用 login() 或 setToken()");
    }
    const promise = this.loginPromise || this.startLogin(this.username, this.password);
    const revision = this.revision;
    const result = await promise;
    this.assertRevision(revision);
    if (result.requires2FA) throw new TwoFactorRequiredError(result);
    return result.token;
  }

  assertToken(token: string): void {
    if (this.token !== token) throw new Error("认证状态已变更，请重新请求");
  }

  getIdentityRevision(): number {
    return this.identityRevision;
  }

  assertIdentityRevision(revision: number): void {
    if (this.identityRevision !== revision) throw new Error("认证状态已变更，请重新请求");
  }

  async retryToken(requestToken: string): Promise<string> {
    this.assertToken(requestToken);
    this.token = null;
    return this.ensureToken();
  }

  private assertRevision(revision: number): void {
    if (this.revision !== revision) throw new Error("认证状态已变更，请重新登录");
  }

  private async post(path: string, body: Record<string, string>): Promise<{
    token?: string; requires2FA?: boolean; ticket?: string; username?: string;
  }> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeout),
    });
    if (!response.ok) throw new Error(`认证失败 (${response.status}): ${await response.text()}`);
    return response.json();
  }
}
