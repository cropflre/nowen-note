// backend/src/plugins/studio/projectPaths.ts
import fs from "node:fs";
import path from "node:path";

// backend/src/plugins/studio/types.ts
var PluginStudioError = class extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
    this.name = "PluginStudioError";
  }
};

// backend/src/plugins/studio/projectPaths.ts
var PLUGIN_STUDIO_MAX_FILES = 200;
var PLUGIN_STUDIO_MAX_FILE_BYTES = 2 * 1024 * 1024;
var PLUGIN_STUDIO_MAX_PROJECT_BYTES = 10 * 1024 * 1024;
var FILE_TYPES = /* @__PURE__ */ new Map([
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
  [".webp", { mimeType: "image/webp", encoding: "base64" }]
]);
function assertProjectId(projectId) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(projectId)) {
    throw new PluginStudioError("\u65E0\u6548\u7684 Studio \u9879\u76EE ID", "PLUGIN_STUDIO_INVALID_PROJECT_ID");
  }
}
function normalizeStudioRelativePath(input) {
  const value = String(input || "").trim();
  if (!value || value.includes("\0") || value.includes("\\") || path.posix.isAbsolute(value)) {
    throw new PluginStudioError("\u9879\u76EE\u6587\u4EF6\u8DEF\u5F84\u65E0\u6548", "PLUGIN_STUDIO_INVALID_PATH");
  }
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new PluginStudioError("\u9879\u76EE\u6587\u4EF6\u8DEF\u5F84\u4E0D\u80FD\u79BB\u5F00\u9879\u76EE\u76EE\u5F55", "PLUGIN_STUDIO_PATH_TRAVERSAL");
  }
  return segments.join("/");
}
function fileType(relativePath) {
  const result = FILE_TYPES.get(path.posix.extname(relativePath).toLowerCase());
  if (!result) {
    throw new PluginStudioError("\u8BE5\u6587\u4EF6\u7C7B\u578B\u4E0D\u5141\u8BB8\u5199\u5165 Studio \u9879\u76EE", "PLUGIN_STUDIO_FILE_TYPE_NOT_ALLOWED");
  }
  return result;
}
function getPluginStudioProjectsRoot() {
  const dataRoot = process.env.ELECTRON_USER_DATA || path.join(process.cwd(), "data");
  return path.join(dataRoot, "plugin-projects");
}
var PluginStudioProjectPaths = class {
  root;
  constructor(root = getPluginStudioProjectsRoot()) {
    fs.mkdirSync(root, { recursive: true, mode: 448 });
    const rootStat = fs.lstatSync(root);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      throw new PluginStudioError("Studio \u9879\u76EE\u6839\u76EE\u5F55\u4E0D\u5B89\u5168", "PLUGIN_STUDIO_UNSAFE_ROOT");
    }
    this.root = fs.realpathSync(root);
  }
  projectDirectory(projectId) {
    this.assertRootSafe();
    assertProjectId(projectId);
    return path.join(this.root, projectId);
  }
  createProjectDirectory(projectId) {
    const directory = this.projectDirectory(projectId);
    fs.mkdirSync(directory, { recursive: false, mode: 448 });
    return directory;
  }
  resolveFile(projectId, input, allowMissingLeaf = false) {
    const relativePath = normalizeStudioRelativePath(input);
    fileType(relativePath);
    const projectDirectory = this.projectDirectory(projectId);
    const candidate = path.resolve(projectDirectory, ...relativePath.split("/"));
    if (!candidate.startsWith(`${projectDirectory}${path.sep}`)) {
      throw new PluginStudioError("\u9879\u76EE\u6587\u4EF6\u8DEF\u5F84\u4E0D\u80FD\u79BB\u5F00\u9879\u76EE\u76EE\u5F55", "PLUGIN_STUDIO_PATH_TRAVERSAL");
    }
    this.assertNoSymlink(projectDirectory, relativePath, allowMissingLeaf);
    return candidate;
  }
  assertNoSymlink(projectDirectory, relativePath, allowMissingLeaf) {
    const projectStat = fs.lstatSync(projectDirectory, { throwIfNoEntry: false });
    if (!projectStat?.isDirectory() || projectStat.isSymbolicLink()) {
      throw new PluginStudioError("Studio \u9879\u76EE\u76EE\u5F55\u4E0D\u5B89\u5168", "PLUGIN_STUDIO_SYMLINK_REJECTED");
    }
    const segments = relativePath.split("/");
    let current = projectDirectory;
    for (let index = 0; index < segments.length; index += 1) {
      current = path.join(current, segments[index]);
      const stat = fs.lstatSync(current, { throwIfNoEntry: false });
      if (!stat) {
        if (allowMissingLeaf) return;
        throw new PluginStudioError("\u9879\u76EE\u6587\u4EF6\u4E0D\u5B58\u5728", "PLUGIN_STUDIO_FILE_NOT_FOUND");
      }
      if (stat.isSymbolicLink()) {
        throw new PluginStudioError("Studio \u9879\u76EE\u4E0D\u5141\u8BB8\u7B26\u53F7\u94FE\u63A5", "PLUGIN_STUDIO_SYMLINK_REJECTED");
      }
      if (stat.isFile() && stat.nlink !== 1) {
        throw new PluginStudioError("Studio \u9879\u76EE\u4E0D\u5141\u8BB8\u786C\u94FE\u63A5", "PLUGIN_STUDIO_HARDLINK_REJECTED");
      }
      if (index < segments.length - 1 && !stat.isDirectory()) {
        throw new PluginStudioError("\u9879\u76EE\u6587\u4EF6\u8DEF\u5F84\u65E0\u6548", "PLUGIN_STUDIO_INVALID_PATH");
      }
    }
  }
  assertRootSafe() {
    const stat = fs.lstatSync(this.root, { throwIfNoEntry: false });
    if (!stat?.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(this.root) !== this.root) {
      throw new PluginStudioError("Studio \u9879\u76EE\u6839\u76EE\u5F55\u4E0D\u5B89\u5168", "PLUGIN_STUDIO_UNSAFE_ROOT");
    }
  }
  readFileBuffer(projectId, input) {
    const absolutePath = this.resolveFile(projectId, input);
    const expected = fs.lstatSync(absolutePath, { bigint: true });
    let descriptor;
    try {
      descriptor = fs.openSync(absolutePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    } catch (error) {
      if (error.code === "ELOOP") {
        throw new PluginStudioError("Studio \u9879\u76EE\u4E0D\u5141\u8BB8\u7B26\u53F7\u94FE\u63A5", "PLUGIN_STUDIO_SYMLINK_REJECTED");
      }
      throw error;
    }
    try {
      const opened = fs.fstatSync(descriptor, { bigint: true });
      const requireSameFile = () => {
        this.resolveFile(projectId, input);
        const current = fs.lstatSync(absolutePath, { bigint: true });
        const handle = fs.fstatSync(descriptor, { bigint: true });
        if (!handle.isFile() || handle.nlink !== 1n || expected.dev !== handle.dev || expected.ino !== handle.ino || current.dev !== handle.dev || current.ino !== handle.ino || handle.size !== opened.size || handle.mtimeNs !== opened.mtimeNs) {
          throw new PluginStudioError("\u9879\u76EE\u6587\u4EF6\u5728\u8BFB\u53D6\u671F\u95F4\u53D1\u751F\u53D8\u5316\uFF0C\u8BF7\u91CD\u8BD5", "PLUGIN_STUDIO_FILE_CHANGED");
        }
      };
      requireSameFile();
      if (opened.size > BigInt(PLUGIN_STUDIO_MAX_FILE_BYTES)) {
        throw new PluginStudioError("\u5355\u4E2A\u9879\u76EE\u6587\u4EF6\u4E0D\u80FD\u8D85\u8FC7 2 MiB", "PLUGIN_STUDIO_FILE_TOO_LARGE");
      }
      const buffer = Buffer.alloc(Number(opened.size) + 1);
      let length = 0;
      while (length < buffer.length) {
        const read = fs.readSync(descriptor, buffer, length, buffer.length - length, length);
        if (!read) break;
        length += read;
      }
      requireSameFile();
      if (length !== Number(opened.size)) {
        throw new PluginStudioError("\u9879\u76EE\u6587\u4EF6\u5728\u8BFB\u53D6\u671F\u95F4\u53D1\u751F\u53D8\u5316\uFF0C\u8BF7\u91CD\u8BD5", "PLUGIN_STUDIO_FILE_CHANGED");
      }
      return buffer.subarray(0, length);
    } finally {
      fs.closeSync(descriptor);
    }
  }
  describeFile(relativePath, size) {
    const normalized = normalizeStudioRelativePath(relativePath);
    return { path: normalized, size, ...fileType(normalized) };
  }
  listFiles(projectId) {
    const projectDirectory = this.projectDirectory(projectId);
    const projectStat = fs.lstatSync(projectDirectory, { throwIfNoEntry: false });
    if (!projectStat?.isDirectory() || projectStat.isSymbolicLink()) {
      throw new PluginStudioError("Studio \u9879\u76EE\u76EE\u5F55\u4E0D\u5B89\u5168", "PLUGIN_STUDIO_SYMLINK_REJECTED");
    }
    const files = [];
    const walk = (directory, prefix) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isSymbolicLink()) {
          throw new PluginStudioError("Studio \u9879\u76EE\u4E0D\u5141\u8BB8\u7B26\u53F7\u94FE\u63A5", "PLUGIN_STUDIO_SYMLINK_REJECTED");
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
};
export {
  PLUGIN_STUDIO_MAX_FILES,
  PLUGIN_STUDIO_MAX_FILE_BYTES,
  PLUGIN_STUDIO_MAX_PROJECT_BYTES,
  PluginStudioProjectPaths,
  getPluginStudioProjectsRoot,
  normalizeStudioRelativePath
};
