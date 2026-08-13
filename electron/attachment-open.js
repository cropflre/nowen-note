const fs = require("node:fs");
const path = require("node:path");

const ATTACHMENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isPathInsideRoot(rootPath, candidatePath) {
  const relative = path.relative(rootPath, candidatePath);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function openLocalAttachmentWithSystem({
  attachmentId,
  mode,
  attachmentsRoot,
  loadMetadata,
  openPath,
}) {
  if (typeof attachmentId !== "string" || !ATTACHMENT_ID_PATTERN.test(attachmentId)) {
    return { ok: false, error: "INVALID_ATTACHMENT_ID" };
  }
  if (mode !== "full") return { ok: false, error: "NOT_FULL_MODE" };

  let metadata;
  try {
    metadata = await loadMetadata(attachmentId);
  } catch (error) {
    return { ok: false, error: "ATTACHMENT_METADATA_FAILED", message: error?.message || String(error) };
  }
  if (!metadata || metadata.ok === false) {
    return {
      ok: false,
      error: metadata?.error || "ATTACHMENT_NOT_FOUND",
      message: metadata?.message,
    };
  }
  if (metadata.driver !== "local") return { ok: false, error: "STORAGE_NOT_LOCAL" };
  if (typeof metadata.path !== "string" || !metadata.path.trim() || path.isAbsolute(metadata.path)) {
    return { ok: false, error: "INVALID_ATTACHMENT_PATH" };
  }

  const root = path.resolve(attachmentsRoot);
  const candidate = path.resolve(root, metadata.path);
  if (!isPathInsideRoot(root, candidate)) {
    return { ok: false, error: "PATH_OUTSIDE_ATTACHMENTS_ROOT" };
  }
  if (!fs.existsSync(candidate)) return { ok: false, error: "ATTACHMENT_FILE_NOT_FOUND" };

  let rootReal;
  let fileReal;
  try {
    rootReal = fs.realpathSync(root);
    fileReal = fs.realpathSync(candidate);
  } catch (error) {
    return { ok: false, error: "ATTACHMENT_FILE_NOT_FOUND", message: error?.message || String(error) };
  }
  if (!isPathInsideRoot(rootReal, fileReal)) {
    return { ok: false, error: "PATH_OUTSIDE_ATTACHMENTS_ROOT" };
  }
  try {
    if (!fs.statSync(fileReal).isFile()) return { ok: false, error: "ATTACHMENT_NOT_FILE" };
  } catch (error) {
    return { ok: false, error: "ATTACHMENT_FILE_NOT_FOUND", message: error?.message || String(error) };
  }

  try {
    const message = await openPath(fileReal);
    if (message) return { ok: false, error: "OPEN_FAILED", message };
    return { ok: true };
  } catch (error) {
    return { ok: false, error: "OPEN_FAILED", message: error?.message || String(error) };
  }
}

module.exports = {
  openLocalAttachmentWithSystem,
};
