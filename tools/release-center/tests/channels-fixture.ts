// Deterministic provider boundary. Unexpected requests fail instead of reaching a real service.
import { createRequire } from "node:module";
import { GitHub } from "../server/github.ts";
import { AppError } from "../server/errors.ts";

const require = createRequire(import.meta.url);
export const { STORE_IDENTITY } = require("../../../electron/storeIdentity.js");
export const channelSha = "c".repeat(40);
export const channelDigest = `sha256:${"d".repeat(64)}`;
export const storeToken = "fixture-partner-center-credential";
export class ChannelGitHub extends GitHub {
  calls: string[] = [];
  release: any = {
    id: 301, tag_name: "v1.5.2", draft: false, prerelease: false,
    published_at: "2026-10-16T00:00:00Z", assets: [
      { id: 401, name: "nowen-note-1.5.2.fpk", size: 120, digest: channelDigest },
      { id: 402, name: "x86_64_nowen-note_1.5.2.1.upk", size: 240, digest: channelDigest },
      { id: 403, name: "nowen-note-1.5.20.fpk", size: 120, digest: channelDigest },
      { id: 404, name: "Nowen-Note-Setup-1.5.2.exe", size: 480, digest: channelDigest },
    ],
  };
  tag: any = { type: "commit", sha: channelSha };
  annotated: any = { type: "commit", sha: channelSha };
  storeRuns: any[] = [{ id: 501, head_sha: channelSha, status: "completed", conclusion: "success", path: ".github/workflows/microsoft-store-appx.yml" }];
  storeArtifacts: any[] = [{ id: 601, name: "nowen-note-store-appx", size: 100, digest: channelDigest, expired: false, verification: "not_downloaded" }];
  error?: AppError;
  constructor() { super("ghp_channel_fixture_secret"); }
  override async request(path: string, method = "GET"): Promise<any> {
    this.calls.push(`${method} ${path}`);
    if (method !== "GET") throw new Error(`Unexpected mutation: ${method} ${path}`);
    if (this.error) throw this.error;
    if (path === "releases/tags/v1.5.2") return structuredClone(this.release);
    if (path === "git/ref/tags/v1.5.2") return { object: structuredClone(this.tag) };
    if (path.startsWith("git/tags/")) return { object: structuredClone(this.annotated) };
    throw new AppError(404, "Fixture resource not found");
  }
  override async list(path: string): Promise<any[]> {
    this.calls.push(`GET ${path}`);
    if (path === `actions/workflows/microsoft-store-appx.yml/runs?head_sha=${channelSha}&status=completed`)
      return structuredClone(this.storeRuns);
    throw new Error(`Unexpected list: ${path}`);
  }
  override async artifacts(id: number) {
    this.calls.push(`GET artifacts/${id}`);
    if (id !== 501) throw new Error(`Unexpected artifact run: ${id}`);
    return structuredClone(this.storeArtifacts);
  }
}
export class ChannelProvider {
  calls: { url: string; init?: RequestInit }[] = [];
  dockerStatus = 200;
  docker: any = { name: "v1.5.2", digest: channelDigest, images: [{ architecture: "amd64", os: "linux", digest: channelDigest, size: 100 }] };
  app: any = { id: STORE_IDENTITY.storeId, packageIdentityName: STORE_IDENTITY.identityName, publisherName: STORE_IDENTITY.publisher,
    pendingApplicationSubmission: { id: "pending-1" }, lastPublishedApplicationSubmission: { id: "published-1" } };
  submissions: Record<string, any> = {
    "pending-1": { id: "pending-1", status: "Certification", applicationPackages: [{ version: "1.5.2.0" }], fileUploadUrl: "https://storage.invalid/package?sig=must-not-leak" },
    "published-1": { id: "published-1", status: "Published", applicationPackages: [{ version: "1.5.1.0" }] },
  };
  storeStatus = 200;
  blocker?: Promise<void>;
  response?: () => Response;
  transport: typeof fetch = async (input, init) => {
    const url = String(input);
    this.calls.push({ url, init });
    await this.blocker;
    if (this.response) return this.response();
    if (url === "https://hub.docker.com/v2/namespaces/cropflre/repositories/nowen-note/tags/v1.5.2")
      return Response.json(this.docker, { status: this.dockerStatus });
    const base = `https://manage.devcenter.microsoft.com/v1.0/my/applications/${STORE_IDENTITY.storeId}`;
    if (url === base) return Response.json(this.app, { status: this.storeStatus });
    if (url.startsWith(`${base}/submissions/`)) {
      const id = url.slice(`${base}/submissions/`.length);
      if (!(id in this.submissions)) throw new Error(`Unexpected submission: ${id}`);
      return Response.json(this.submissions[id]);
    }
    throw new Error(`Unexpected provider URL: ${url}`);
  };
}
