import {
  REPO,
  WORKFLOW,
  type Artifact,
  type Job,
  type Release,
  type Run,
} from "../shared.ts";
import { AppError } from "./errors.ts";
import { createWriteStream, createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

export class GitHub {
  constructor(
    readonly token = "",
    private transport: typeof fetch = fetch,
  ) {}
  async authenticatedUser(): Promise<{ id: number; login: string; type: string }> {
    const response = await this.transport("https://api.github.com/user", {
      headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${this.token}`, "X-GitHub-Api-Version": "2022-11-28" },
      redirect: "error", signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new AppError(response.status, "无法核验服务端发布凭据的 GitHub 身份");
    return response.json();
  }
  async tagCommit(tag: string): Promise<string> {
    let object = (await this.request(`git/ref/tags/${encodeURIComponent(tag)}`)).object;
    for (let depth = 0; object?.type === "tag" && depth < 5; depth++) {
      if (!/^[a-f0-9]{40}$/.test(object.sha)) throw new AppError(502, "无效 Tag SHA");
      object = (await this.request(`git/tags/${object.sha}`)).object;
    }
    if (object?.type !== "commit" || !/^[a-f0-9]{40}$/.test(object.sha)) throw new AppError(409, "不能固定 Tag Commit");
    return object.sha;
  }
  async uploadReleaseAsset(releaseId: number, name: string, path: string, signal: AbortSignal) {
    if (!Number.isSafeInteger(releaseId) || releaseId <= 0 || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(name))
      throw new AppError(400, "无效产物上传参数");
    const file = createReadStream(path);
    try {
      const response = await this.transport(`https://uploads.github.com/repos/${REPO}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`, {
        method: "POST", redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(30 * 60_000)]),
        headers: { Authorization: `Bearer ${this.token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/octet-stream", "Content-Length": String((await stat(path)).size) },
        body: file as any, duplex: "half",
      } as RequestInit);
      if (!response.ok) throw new AppError(response.status, `GitHub 产物上传失败 (${response.status})；禁止覆盖或删除重传`);
      return await response.json();
    } finally { file.destroy(); }
  }
  async request(path: string, method = "GET", body?: unknown): Promise<any> {
    const response = await this.transport(
      `https://api.github.com/repos/${REPO}/${path}`,
      {
        method,
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(20_000),
        redirect: "error",
      },
    );
    if (!response.ok) {
      const status = response.status;
      if (status === 401) throw new AppError(401, "GitHub Token 无效或已过期");
      if (
        status === 429 ||
        (status === 403 &&
          (response.headers.get("x-ratelimit-remaining") === "0" ||
            response.headers.has("retry-after")))
      ) {
        throw new AppError(
          429,
          `GitHub API 限流；重置时间：${response.headers.get("x-ratelimit-reset") || "见 Retry-After"}`,
          response.headers.get("retry-after") || "60",
        );
      }
      throw new AppError(
        status,
        `GitHub API ${status}：${status === 403 ? "权限不足" : status === 404 ? "资源不存在或无访问权限" : "请求失败"}`,
      );
    }
    if (response.status === 204) return null;
    return response.json();
  }
  async list(path: string, key?: string): Promise<any[]> {
    const output: any[] = [];
    for (let page = 1; page <= 10; page++) {
      const data = await this.request(
        `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`,
      );
      const items = key ? data[key] : data;
      if (!Array.isArray(items))
        throw new AppError(502, "GitHub 返回了无效列表");
      output.push(...items);
      if (items.length < 100) return output;
    }
    throw new AppError(502, "GitHub 分页超过安全上限；请缩小查询范围");
  }
  async content(path: string, sha: string): Promise<string> {
    const data = await this.request(
      `contents/${path}?ref=${encodeURIComponent(sha)}`,
    );
    if (data.encoding !== "base64" || typeof data.content !== "string")
      throw new AppError(502, "无法读取版本文件");
    return Buffer.from(data.content, "base64").toString("utf8");
  }
  async resolve(branch: string): Promise<string> {
    const data = await this.request(`branches/${encodeURIComponent(branch)}`);
    if (!/^[a-f0-9]{40}$/.test(data.commit?.sha))
      throw new AppError(502, "GitHub 返回了无效 Commit SHA");
    return data.commit.sha;
  }
  async exists(path: string): Promise<boolean> {
    try {
      await this.request(path);
      return true;
    } catch (error) {
      if (error instanceof AppError && error.status === 404) return false;
      throw error;
    }
  }
  async releases(): Promise<Release[]> {
    return (await this.list("releases")).map((r) => ({
      id: r.id,
      tag: r.tag_name,
      draft: r.draft,
      prerelease: r.prerelease,
      publishedAt: r.published_at,
      url: r.html_url,
      assets: r.assets.map((a: any) => ({
        name: a.name,
        size: a.size,
        digest: a.digest || null,
      })),
    }));
  }
  async runs(): Promise<Run[]> {
    const data = await this.request("actions/runs?per_page=20");
    return data.workflow_runs.map((r: any) => ({
      id: r.id,
      title: r.display_title,
      workflow: r.name,
      sha: r.head_sha,
      status: r.status,
      conclusion: r.conclusion,
      url: r.html_url,
      event: r.event,
    }));
  }
  async dispatch(ref: string, inputs: Record<string, string>) {
    if (!this.token) throw new AppError(403, "调试构建需要服务端 GitHub Token");
    await this.request(`actions/workflows/${WORKFLOW}/dispatches`, "POST", {
      ref,
      inputs,
    });
  }
  async findRun(taskId: string, since: string): Promise<any | undefined> {
    const runs = await this.list(
      `actions/workflows/${WORKFLOW}/runs?event=workflow_dispatch&created=${encodeURIComponent(`>=${since}`)}`,
      "workflow_runs",
    );
    const matches = runs.filter(
      (r) =>
        r.display_title === `Release Center debug ${taskId}` &&
        r.event === "workflow_dispatch",
    );
    if (matches.length > 1)
      throw new AppError(409, "发现重复的远端任务；需要人工检查，不自动重试");
    return matches[0];
  }
  async run(id: number) {
    return this.request(`actions/runs/${id}`);
  }
  async jobs(id: number): Promise<Job[]> {
    return (await this.list(`actions/runs/${id}/jobs`, "jobs")).map((j) => ({
      id: j.id,
      name: j.name,
      status: j.status,
      conclusion: j.conclusion,
      steps: (j.steps || []).map((s: any) => ({
        name: s.name,
        status: s.status,
        conclusion: s.conclusion,
      })),
    }));
  }
  async artifacts(id: number): Promise<Artifact[]> {
    return (await this.list(`actions/runs/${id}/artifacts`, "artifacts")).map(
      (a) => ({
        id: a.id,
        name: a.name,
        size: a.size_in_bytes,
        digest: a.digest || null,
        expired: a.expired,
        verification: "not_downloaded",
      }),
    );
  }
  async artifactMeta(id: number): Promise<any> {
    return this.request(`actions/artifacts/${id}`);
  }
  async downloadArtifact(
    id: number,
    path: string,
    signal: AbortSignal,
    maxBytes: number,
  ) {
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(30 * 60_000)]);
    const response = await this.transport(
      `https://api.github.com/repos/${REPO}/actions/artifacts/${id}/zip`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        },
        redirect: "manual",
        signal: bounded,
      },
    );
    if (response.status !== 302)
      throw new AppError(
        response.status,
        "GitHub artifact 下载未就绪或权限不足",
      );
    const location = new URL(response.headers.get("location") || "");
    if (
      location.protocol !== "https:" ||
      location.username ||
      location.password ||
      (location.port && location.port !== "443") ||
      !/(?:\.blob\.core\.windows\.net|\.githubusercontent\.com)$/.test(
        location.hostname,
      )
    )
      throw new AppError(502, "artifact 下载地址不在允许范围内");
    const result = await this.transport(location, {
      redirect: "error",
      signal: bounded,
    });
    if (!result.ok || !result.body)
      throw new AppError(502, "artifact 下载失败");
    if (Number(result.headers.get("content-length")) > maxBytes) {
      await result.body.cancel();
      throw new AppError(413, "artifact 超过下载上限");
    }
    let size = 0;
    const limit = new Transform({
      transform(chunk, _encoding, callback) {
        size += chunk.length;
        callback(
          size > maxBytes ? new AppError(413, "artifact 超过下载上限") : null,
          chunk,
        );
      },
    });
    await pipeline(
      Readable.fromWeb(result.body as any),
      limit,
      createWriteStream(path, { flags: "wx", mode: 0o600 }),
      { signal: bounded },
    );
  }
  async cancel(id: number) {
    try {
      await this.request(`actions/runs/${id}/cancel`, "POST");
    } catch (error) {
      if (!(error instanceof AppError && error.status === 409)) throw error;
    }
  }
  async jobLog(id: number): Promise<string> {
    const response = await this.transport(
      `https://api.github.com/repos/${REPO}/actions/jobs/${id}/logs`,
      {
        headers: this.token ? { Authorization: `Bearer ${this.token}` } : {},
        redirect: "manual",
        signal: AbortSignal.timeout(20_000),
      },
    );
    if (response.status !== 302)
      throw new AppError(response.status, "日志暂不可用，任务完成后可重试");
    const location = new URL(response.headers.get("location") || "");
    if (
      location.protocol !== "https:" ||
      !/(?:\.blob\.core\.windows\.net|\.githubusercontent\.com)$/.test(
        location.hostname,
      )
    ) {
      throw new AppError(502, "GitHub 日志地址不在允许范围内");
    }
    // Never forward Authorization to the signed storage URL.
    const result = await this.transport(location, {
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
    if (!result.ok || !result.body) throw new AppError(502, "读取日志失败");
    const reader = result.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 2_000_000)
          throw new AppError(413, "日志超过 2 MB，请到 GitHub 查看完整日志");
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
    }
    return Buffer.concat(chunks).toString("utf8");
  }
}
