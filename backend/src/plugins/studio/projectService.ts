import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import JSZip from "jszip";
import { getDb } from "../../db/schema.js";
import {
  PLUGIN_STUDIO_MAX_FILE_BYTES,
  PLUGIN_STUDIO_MAX_FILES,
  PLUGIN_STUDIO_MAX_PROJECT_BYTES,
  PluginStudioProjectPaths,
} from "./projectPaths.js";
import {
  PluginStudioError,
  type PluginStudioActor,
  type PluginStudioFileContent,
  type PluginStudioProjectFile,
  type PluginStudioProject,
  type PluginStudioProjectStatus,
  type PluginStudioWriteFileInput,
} from "./types.js";

type ProjectRow = PluginStudioProject;

function normalizeProjectName(input: string): string {
  const name = String(input || "").trim().replace(/\s+/g, " ");
  if (!name || name.length > 80) {
    throw new PluginStudioError("项目名称长度必须为 1 到 80 个字符", "PLUGIN_STUDIO_INVALID_NAME");
  }
  return name;
}

function projectSlug(name: string, id: string): string {
  const base = name.normalize("NFKD").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "plugin";
  return `${base}-${id.slice(0, 8)}`;
}

function decodeContent(input: PluginStudioWriteFileInput, requiredEncoding: "utf8" | "base64"): Buffer {
  const encoding = input.encoding || "utf8";
  if (encoding !== requiredEncoding) {
    throw new PluginStudioError("文件编码与文件类型不匹配", "PLUGIN_STUDIO_ENCODING_MISMATCH");
  }
  if (typeof input.content !== "string") {
    throw new PluginStudioError("文件内容必须是字符串", "PLUGIN_STUDIO_INVALID_CONTENT");
  }
  if (encoding === "utf8") return Buffer.from(input.content, "utf8");
  const compact = input.content.replace(/\s/g, "");
  if (!compact || compact.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) {
    throw new PluginStudioError("Base64 文件内容无效", "PLUGIN_STUDIO_INVALID_CONTENT");
  }
  return Buffer.from(compact, "base64");
}

export class PluginStudioProjectService {
  constructor(
    private readonly db: Database.Database = getDb(),
    private readonly paths = new PluginStudioProjectPaths(),
  ) {}

  createProject(actor: PluginStudioActor, input: { name: string }): PluginStudioProject {
    this.assertAuthenticated(actor);
    const id = crypto.randomUUID();
    const name = normalizeProjectName(input.name);
    const now = new Date().toISOString();
    const project: PluginStudioProject = {
      id,
      ownerUserId: actor.userId,
      name,
      slug: projectSlug(name, id),
      status: "draft",
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };
    const directory = this.paths.createProjectDirectory(id);
    try {
      this.db.prepare(`
        INSERT INTO plugin_studio_projects (
          id, ownerUserId, name, slug, status, revision, createdAt, updatedAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        project.id,
        project.ownerUserId,
        project.name,
        project.slug,
        project.status,
        project.revision,
        project.createdAt,
        project.updatedAt,
      );
      return project;
    } catch (error) {
      fs.rmdirSync(directory);
      throw error;
    }
  }

  listProjects(actor: PluginStudioActor): PluginStudioProject[] {
    this.assertAuthenticated(actor);
    if (actor.isAdmin) {
      return this.db.prepare(`
        SELECT id, ownerUserId, name, slug, status, revision, createdAt, updatedAt
        FROM plugin_studio_projects ORDER BY updatedAt DESC
      `).all() as ProjectRow[];
    }
    return this.db.prepare(`
      SELECT id, ownerUserId, name, slug, status, revision, createdAt, updatedAt
      FROM plugin_studio_projects WHERE ownerUserId = ? ORDER BY updatedAt DESC
    `).all(actor.userId) as ProjectRow[];
  }

  getProject(actor: PluginStudioActor, projectId: string): PluginStudioProject {
    this.assertAuthenticated(actor);
    const project = this.db.prepare(`
      SELECT id, ownerUserId, name, slug, status, revision, createdAt, updatedAt
      FROM plugin_studio_projects WHERE id = ?
    `).get(projectId) as ProjectRow | undefined;
    if (!project) throw new PluginStudioError("Studio 项目不存在", "PLUGIN_STUDIO_PROJECT_NOT_FOUND");
    if (!actor.isAdmin && project.ownerUserId !== actor.userId) {
      throw new PluginStudioError("无权访问该 Studio 项目", "PLUGIN_STUDIO_FORBIDDEN");
    }
    return project;
  }

  updateProject(
    actor: PluginStudioActor,
    projectId: string,
    input: { name?: string; status?: PluginStudioProjectStatus; expectedRevision: number },
  ): PluginStudioProject {
    const project = this.getProject(actor, projectId);
    this.assertExpectedRevision(project, input.expectedRevision);
    const name = input.name === undefined ? project.name : normalizeProjectName(input.name);
    const status = input.status === undefined ? project.status : input.status;
    if (!["draft", "ready", "archived"].includes(status)) {
      throw new PluginStudioError("无效的项目状态", "PLUGIN_STUDIO_INVALID_STATUS");
    }
    const updatedAt = new Date().toISOString();
    const result = this.db.prepare(`
      UPDATE plugin_studio_projects
      SET name = ?, status = ?, revision = revision + 1, updatedAt = ?
      WHERE id = ? AND revision = ?
    `).run(name, status, updatedAt, projectId, input.expectedRevision);
    if (result.changes !== 1) this.throwRevisionConflict();
    return this.getProject(actor, projectId);
  }

  listFiles(actor: PluginStudioActor, projectId: string) {
    this.getProject(actor, projectId);
    return this.paths.listFiles(projectId);
  }

  readFile(actor: PluginStudioActor, projectId: string, requestedPath: string): PluginStudioFileContent {
    this.getProject(actor, projectId);
    const absolutePath = this.paths.resolveFile(projectId, requestedPath);
    const stat = fs.statSync(absolutePath);
    if (!stat.isFile()) throw new PluginStudioError("项目文件不存在", "PLUGIN_STUDIO_FILE_NOT_FOUND");
    const description = this.paths.describeFile(requestedPath, stat.size);
    const buffer = fs.readFileSync(absolutePath);
    return {
      ...description,
      content: description.encoding === "base64" ? buffer.toString("base64") : buffer.toString("utf8"),
    };
  }

  writeFile(
    actor: PluginStudioActor,
    projectId: string,
    input: PluginStudioWriteFileInput,
  ): { project: PluginStudioProject; file: PluginStudioFileContent } {
    const project = this.getProject(actor, projectId);
    this.assertExpectedRevision(project, input.expectedRevision);
    if (project.status === "archived") {
      throw new PluginStudioError("归档项目不可写入", "PLUGIN_STUDIO_PROJECT_ARCHIVED");
    }

    const targetPath = this.paths.resolveFile(projectId, input.path, true);
    const type = this.paths.describeFile(input.path, 0);
    const content = decodeContent(input, type.encoding);
    if (content.byteLength > PLUGIN_STUDIO_MAX_FILE_BYTES) {
      throw new PluginStudioError("单个项目文件不能超过 2 MiB", "PLUGIN_STUDIO_FILE_TOO_LARGE");
    }

    const existingFiles = this.paths.listFiles(projectId);
    const existing = existingFiles.find((file) => file.path === type.path);
    const nextCount = existing ? existingFiles.length : existingFiles.length + 1;
    const nextBytes = existingFiles.reduce((total, file) => total + file.size, 0)
      - (existing?.size || 0) + content.byteLength;
    if (nextCount > PLUGIN_STUDIO_MAX_FILES) {
      throw new PluginStudioError("单个项目最多包含 200 个文件", "PLUGIN_STUDIO_FILE_LIMIT_EXCEEDED");
    }
    if (nextBytes > PLUGIN_STUDIO_MAX_PROJECT_BYTES) {
      throw new PluginStudioError("单个项目文件总量不能超过 10 MiB", "PLUGIN_STUDIO_PROJECT_TOO_LARGE");
    }

    fs.mkdirSync(path.dirname(targetPath), { recursive: true, mode: 0o700 });
    this.paths.resolveFile(projectId, input.path, true);
    const temporaryPath = path.join(path.dirname(targetPath), `.${path.basename(targetPath)}.${crypto.randomUUID()}.tmp`);
    fs.writeFileSync(temporaryPath, content, { flag: "wx", mode: 0o600 });
    const updatedAt = new Date().toISOString();
    try {
      const commit = this.db.transaction(() => {
        const result = this.db.prepare(`
          UPDATE plugin_studio_projects
          SET revision = revision + 1, updatedAt = ?
          WHERE id = ? AND revision = ?
        `).run(updatedAt, projectId, input.expectedRevision);
        if (result.changes !== 1) this.throwRevisionConflict();
        fs.renameSync(temporaryPath, targetPath);
      });
      commit();
    } finally {
      try { fs.unlinkSync(temporaryPath); } catch { /* renamed or already removed */ }
    }

    return {
      project: this.getProject(actor, projectId),
      file: this.readFile(actor, projectId, input.path),
    };
  }

  async exportProject(actor: PluginStudioActor, projectId: string): Promise<{
    project: PluginStudioProject;
    archive: Buffer;
  }> {
    const project = this.getProject(actor, projectId);
    const files = this.paths.listFiles(projectId);
    const zip = new JSZip();
    zip.file(".nowen-studio-project.json", JSON.stringify({
      formatVersion: 1,
      name: project.name,
      slug: project.slug,
      revision: project.revision,
      exportedAt: new Date().toISOString(),
    }, null, 2));
    for (const file of files) {
      const absolutePath = this.paths.resolveFile(projectId, file.path);
      zip.file(file.path, fs.readFileSync(absolutePath));
    }
    return {
      project,
      archive: await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } }),
    };
  }

  async importProject(
    actor: PluginStudioActor,
    input: { name: string; archive: Buffer },
  ): Promise<PluginStudioProject> {
    this.assertAuthenticated(actor);
    if (input.archive.byteLength > 12 * 1024 * 1024) {
      throw new PluginStudioError("Studio 项目压缩包不能超过 12 MiB", "PLUGIN_STUDIO_IMPORT_TOO_LARGE");
    }
    let zip: JSZip;
    try {
      zip = await JSZip.loadAsync(input.archive, { checkCRC32: true });
    } catch {
      throw new PluginStudioError("Studio 项目压缩包无效", "PLUGIN_STUDIO_IMPORT_INVALID");
    }

    const files: Array<{ description: PluginStudioProjectFile; content: Buffer }> = [];
    let declaredBytes = 0;
    for (const entry of Object.values(zip.files)) {
      if (entry.dir || entry.name === ".nowen-studio-project.json") continue;
      const unsafeOriginalName = (entry as JSZip.JSZipObject & { unsafeOriginalName?: string }).unsafeOriginalName;
      if (unsafeOriginalName && unsafeOriginalName !== entry.name) {
        throw new PluginStudioError("导入包包含越界路径", "PLUGIN_STUDIO_PATH_TRAVERSAL");
      }
      const description = this.paths.describeFile(entry.name, 0);
      const declaredSize = Number((entry as any)._data?.uncompressedSize || 0);
      if (declaredSize > PLUGIN_STUDIO_MAX_FILE_BYTES) {
        throw new PluginStudioError("导入包包含超过 2 MiB 的文件", "PLUGIN_STUDIO_FILE_TOO_LARGE");
      }
      declaredBytes += declaredSize;
      if (declaredBytes > PLUGIN_STUDIO_MAX_PROJECT_BYTES) {
        throw new PluginStudioError("导入项目总量不能超过 10 MiB", "PLUGIN_STUDIO_PROJECT_TOO_LARGE");
      }
      const content = await entry.async("nodebuffer");
      if (content.byteLength > PLUGIN_STUDIO_MAX_FILE_BYTES) {
        throw new PluginStudioError("导入包包含超过 2 MiB 的文件", "PLUGIN_STUDIO_FILE_TOO_LARGE");
      }
      if (description.encoding === "utf8") {
        try {
          new TextDecoder("utf-8", { fatal: true }).decode(content);
        } catch {
          throw new PluginStudioError("导入包包含无效的 UTF-8 文本", "PLUGIN_STUDIO_INVALID_CONTENT");
        }
      }
      files.push({ description: { ...description, size: content.byteLength }, content });
      if (files.length > PLUGIN_STUDIO_MAX_FILES) {
        throw new PluginStudioError("导入项目最多包含 200 个文件", "PLUGIN_STUDIO_FILE_LIMIT_EXCEEDED");
      }
    }
    const totalBytes = files.reduce((total, file) => total + file.content.byteLength, 0);
    if (totalBytes > PLUGIN_STUDIO_MAX_PROJECT_BYTES) {
      throw new PluginStudioError("导入项目总量不能超过 10 MiB", "PLUGIN_STUDIO_PROJECT_TOO_LARGE");
    }

    let project = this.createProject(actor, { name: input.name });
    try {
      for (const file of files) {
        project = this.writeFile(actor, project.id, {
          path: file.description.path,
          content: file.description.encoding === "base64"
            ? file.content.toString("base64")
            : file.content.toString("utf8"),
          encoding: file.description.encoding,
          expectedRevision: project.revision,
        }).project;
      }
    } catch (error) {
      this.db.prepare("DELETE FROM plugin_studio_projects WHERE id = ?").run(project.id);
      fs.rmSync(this.paths.projectDirectory(project.id), { recursive: true, force: true });
      throw error;
    }
    return project;
  }

  private assertAuthenticated(actor: PluginStudioActor): void {
    if (!actor.userId) {
      throw new PluginStudioError("请先登录", "PLUGIN_STUDIO_AUTH_REQUIRED");
    }
  }

  private assertExpectedRevision(project: PluginStudioProject, expectedRevision: number): void {
    if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
      throw new PluginStudioError("expectedRevision 必须是正整数", "PLUGIN_STUDIO_INVALID_REVISION");
    }
    if (project.revision !== expectedRevision) this.throwRevisionConflict();
  }

  private throwRevisionConflict(): never {
    throw new PluginStudioError("项目已被其他操作更新，请刷新后重试", "PLUGIN_STUDIO_REVISION_CONFLICT");
  }
}

let service: PluginStudioProjectService | undefined;

export function getPluginStudioProjectService(): PluginStudioProjectService {
  if (!service) service = new PluginStudioProjectService();
  return service;
}
