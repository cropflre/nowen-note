import { BackupManager } from "../services/backup.js";

const PATCH_FLAG = Symbol.for("nowen.backupLargeArchiveRestore.patched");

const prototype = BackupManager.prototype as unknown as Record<PropertyKey, unknown>;

if (prototype[PATCH_FLAG] !== true) {
  throw new Error(
    "[Backup] 大体积 ZIP 流式恢复补丁未安装，已阻止后端启动，避免恢复流程退回整包 readFileSync 导致 >2GiB 备份失败",
  );
}
