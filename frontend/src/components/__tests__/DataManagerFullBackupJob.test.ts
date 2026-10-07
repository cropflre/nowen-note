import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(path.resolve(__dirname, "../dataManagement/BackupCenter.tsx"), "utf8");

describe("DataManager 手动全量备份", () => {
  it("全量备份走后台任务并持续显示任务状态，数据库备份保留同步路径", () => {
    expect(source).toContain('import { runFullBackupJob } from "@/lib/fullBackupJobClient";');

    const createStart = source.indexOf("const handleCreate = async");
    const createEnd = source.indexOf("const handleImport = async", createStart);
    expect(createStart).toBeGreaterThanOrEqual(0);
    expect(createEnd).toBeGreaterThan(createStart);
    const createSource = source.slice(createStart, createEnd);

    expect(createSource).toContain('type === "full"');
    expect(createSource).toContain("runFullBackupJob(");
    expect(createSource).toContain("api.backup.fullJobs");
    expect(createSource).toContain('onStatus: (text) => setCreateMsg({ type: "progress", text })');
    expect(createSource).toContain("api.backup.create(type, tk)");
  });
});
