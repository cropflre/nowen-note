import fs from "node:fs";
import path from "node:path";
import {
  PluginStudioError,
  type PluginStudioFileEncoding,
  type PluginStudioProjectFile,
} from "./types.js";

export const PLUGIN_STUDIO_MAX_FILES = 200;
export const PLUGIN_STUDIO_MAX_FILE_BYTES = 2 * 1024 * 1024;
export const PLUGIN_STUDIO_MAX_PROJECT_BYTES = 10 * 1024 * 1024;

const FILE_TYPES = new Map<string, { mimeType: string; encoding: PluginStudioFileEncoding }>([
  [".json", { mimeType: "application/json", encoding: "utf8" }],
  [".ts", { mimeType: "text/typescript", encoding: "utf8" }],
  [".tsx", { mimeType: "text/typescript", encoding: "utf8" }],
  [".js", { mimeType: "text/javascript", encoding: "utf8" }],
  [".mjs", { mimeType: "text/javascript", encoding: "utf8" }],
  [".css", { mimeType: "text/css", encoding: "utf8" }],
  [".md", { mimeType: "text/markdown", encoding: "utf8" }],
  [".txt", { mimeType: "text/plain", encoding: "utf8" }],
  [".svg", { mimeType: "image/svg+xml", encoding: "utf8" }],
  [".png", { mimeType: "image/png", encoding: "base64" }],
  [".jpg", { mimeType: "image/jpeg", encoding: "base64" }],
  [".jpeg", { mimeType: "image/jpeg", encoding: "base64" }],
  [".webp", { mimeType: "image/webp", encoding: "base64" }],
]);

function assertProjectId(projectId: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(projectId)) {
    throw new PluginStudioError("无效的 Studio 项目 ID", "PLUGIN_STUDIO_INVALID_PROJECT_ID");
  }
}

export function normalizeStudioRelativePath(input: string): string {
  const value = String(input || "").trim();
  if (!value || value.includes("\0") || value.includes("\\") || path.posix.isAbsolute(value)) {
    throw new PluginStudioError("项目文件路径无效", "PLUGIN_STUDIO_INVALID_PATH");
  }
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new PluginStudioError("项目文件路径不能离开项目目录", "PLUGIN_STUDIO_PATH_TRAVERSAL");
  }
  return segments.join("/");
}

function fileType(relativePath: string): { mimeType: string; encoding: PluginStudioFileEncoding } {
  const result = FILE_TYPES.get(path.posix.extname(relativePath).toLowerCase());
  if (!result) {
    throw new PluginStudioError("该文件类型不允许写入 Studio 项目", "PLUGIN_STUDIO_FILE_TYPE_NOT_ALLOWED");
  }
  return result;
}

export function getPluginStudioProjectsRoot(): string {
  const dataRoot = process.env.ELECTRON_USER_DATA || path.join(process.cwd(), "data");
  return path.join(dataRoot, "plugin-projects");
}

export class PluginStudioProjectPaths {
  readonly root: string;

  constructor(root = getPluginStudioProjectsRoot()) {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const rootStat = fs.lstatSync(root);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      throw new PluginStudioError("Studio 项目根目录不安全", "PLUGIN_STUDIO_UNSAFE_ROOT");
    }
    this.root = fs.realpathSync(root);
  }

  projectDirectory(projectId: string): string {
    this.assertRootSafe();
    assertProjectId(projectId);
    return path.join(this.root, projectId);
  }

  createProjectDirectory(projectId: string): string {
    const directory = this.projectDirectory(projectId);
    fs.mkdirSync(directory, { recursive: false, mode: 0o700 });
    return directory;
  }

  resolveFile(projectId: string, input: string, allowMissingLeaf = false): string {
    const relativePath = normalizeStudioRelativePath(input);
    fileType(relativePath);
    const projectDirectory = this.projectDirectory(projectId);
    const candidate = path.resolve(projectDirectory, ...relativePath.split("/"));
    if (!candidate.startsWith(`${projectDirectory}${path.sep}`)) {
      throw new PluginStudioError("项目文件路径不能离开项目目录", "PLUGIN_STUDIO_PATH_TRAVERSAL");
    }
    this.assertNoSymlink(projectDirectory, relativePath, allowMissingLeaf);
    return candidate;
  }

  private assertNoSymlink(projectDirectory: string, relativePath: string, allowMissingLeaf: boolean): void {
    const projectStat = fs.lstatSync(projectDirectory, { throwIfNoEntry: false });
    if (!projectStat?.isDirectory() || projectStat.isSymbolicLink()) {
      throw new PluginStudioError("Studio 项目目录不安全", "PLUGIN_STUDIO_SYMLINK_REJECTED");
    }
    const segments = relativePath.split("/");
    let current = projectDirectory;
    for (let index = 0; index < segments.length; index += 1) {
      current = path.join(current, segments[index]);
      const stat = fs.lstatSync(current, { throwIfNoEntry: false });
      if (!stat) {
        if (allowMissingLeaf) return;
        throw new PluginStudioError("项目文件不存在", "PLUGIN_STUDIO_FILE_NOT_FOUND");
      }
      if (stat.isSymbolicLink()) {
        throw new PluginStudioError("Studio 项目不允许符号链接", "PLUGIN_STUDIO_SYMLINK_REJECTED");
      }
      if (index < segments.length - 1 && !stat.isDirectory()) {
        throw new PluginStudioError("项目文件路径无效", "PLUGIN_STUDIO_INVALID_PATH");
      }
    }
  }

  private assertRootSafe(): void {
    const stat = fs.lstatSync(this.root, { throwIfNoEntry: false });
    if (!stat?.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(this.root) !== this.root) {
      throw new PluginStudioError("Studio 项目根目录不安全", "PLUGIN_STUDIO_UNSAFE_ROOT");
    }
  }

  describeFile(relativePath: string, size: number): PluginStudioProjectFile {
    const normalized = normalizeStudioRelativePath(relativePath);
    return { path: normalized, size, ...fileType(normalized) };
  }

  listFiles(projectId: string): PluginStudioProjectFile[] {
    const projectDirectory = this.projectDirectory(projectId);
    const projectStat = fs.lstatSync(projectDirectory, { throwIfNoEntry: false });
    if (!projectStat?.isDirectory() || projectStat.isSymbolicLink()) {
      throw new PluginStudioError("Studio 项目目录不安全", "PLUGIN_STUDIO_SYMLINK_REJECTED");
    }
    const files: PluginStudioProjectFile[] = [];
    const walk = (directory: string, prefix: string): void => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isSymbolicLink()) {
          throw new PluginStudioError("Studio 项目不允许符号链接", "PLUGIN_STUDIO_SYMLINK_REJECTED");
        }
        if (entry.isDirectory()) walk(path.join(directory, entry.name), relativePath);
        else if (entry.isFile()) {
          const absolutePath = this.resolveFile(projectId, relativePath);
          files.push(this.describeFile(relativePath, fs.statSync(absolutePath).size));
        }
      }
    };
    walk(projectDirectory, "");
    return files.sort((left, right) => left.path.localeCompare(right.path));
  }
}
