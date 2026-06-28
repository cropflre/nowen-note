/**
 * scanner/hash-store.ts — SHA256 状态管理
 *
 * 记录每个文件的 SHA256 和变更时间，
 * 用于增量扫描时跳过未变更的文件。
 */
import fs from "fs";
import path from "path";

/** 扫描状态文件格式 */
export interface ScanState {
  /** 扫描版本号 */
  version: number;
  /** 上次全量扫描时间 */
  lastFullScanAt: string | null;
  /** 文件路径 → { sha256, mtimeMs } */
  files: Record<string, FileState>;
}

interface FileState {
  sha256: string;
  mtimeMs: number;
}

export class HashStore {
  private state: ScanState;
  private statePath: string;
  private dirty = false;

  constructor(rootDir: string) {
    const metaDir = path.join(rootDir, ".nowen");
    this.statePath = path.join(metaDir, "scan-state.json");
    this.state = this.load();
  }

  /** 加载或初始化状态 */
  private load(): ScanState {
    try {
      if (fs.existsSync(this.statePath)) {
        const raw = fs.readFileSync(this.statePath, "utf-8");
        return JSON.parse(raw);
      }
    } catch {
      // 损坏则重建
    }
    return {
      version: 1,
      lastFullScanAt: null,
      files: {},
    };
  }

  /** 保存状态到磁盘 */
  save(): void {
    if (!this.dirty) return;
    try {
      const dir = path.dirname(this.statePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.statePath, JSON.stringify(this.state, null, 2), "utf-8");
      this.dirty = false;
    } catch (e) {
      console.warn("[scanner/hash-store] save failed:", e);
    }
  }

  /** 文件是否未变更 */
  isUnchanged(relativePath: string, sha256: string, mtimeMs: number): boolean {
    const existing = this.state.files[relativePath];
    if (!existing) return false;
    return existing.sha256 === sha256 && existing.mtimeMs === mtimeMs;
  }

  /** 更新文件状态 */
  updateFile(relativePath: string, sha256: string, mtimeMs: number): void {
    this.state.files[relativePath] = { sha256, mtimeMs };
    this.dirty = true;
  }

  /** 删除文件记录（文件已不存在时） */
  removeFile(relativePath: string): void {
    delete this.state.files[relativePath];
    this.dirty = true;
  }

  /** 获取所有已知文件路径 */
  getKnownFiles(): string[] {
    return Object.keys(this.state.files);
  }

  /** 标记全量扫描完成 */
  markFullScan(): void {
    this.state.lastFullScanAt = new Date().toISOString();
    this.dirty = true;
  }

  /** 获取最后扫描时间 */
  getLastFullScanAt(): string | null {
    return this.state.lastFullScanAt;
  }

  /** 获取已跟踪文件数量 */
  getFileCount(): number {
    return Object.keys(this.state.files).length;
  }
}
