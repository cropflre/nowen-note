import { describe, expect, it, vi } from "vitest";
import { runFullBackupJob } from "../fullBackupJobClient";

describe("runFullBackupJob", () => {
  it("创建任务后只轮询短请求，直到备份可下载", async () => {
    const client = {
      start: vi.fn().mockResolvedValue({ id: "job-1", state: "queued", message: "已排队" }),
      get: vi.fn()
        .mockResolvedValueOnce({ id: "job-1", state: "running", message: "生成中" })
        .mockResolvedValueOnce({
          id: "job-1",
          state: "ready",
          message: "已完成",
          backup: { filename: "full.zip", size: 123 },
          downloadToken: "download-token",
        }),
    };
    const messages: string[] = [];

    const backup = await runFullBackupJob(client, "sudo-token", "手动导出", {
      delay: async () => {},
      onStatus: (message) => messages.push(message),
    });

    expect(backup).toEqual({ filename: "full.zip", size: 123, downloadToken: "download-token" });
    expect(client.start).toHaveBeenCalledWith("sudo-token", "手动导出");
    expect(client.get).toHaveBeenCalledTimes(2);
    expect(messages).toEqual(["已排队", "生成中", "已完成"]);
  });

  it("后台任务失败时抛出服务端错误", async () => {
    const client = {
      start: vi.fn().mockResolvedValue({ id: "job-2", state: "queued", message: "已排队" }),
      get: vi.fn().mockResolvedValue({
        id: "job-2",
        state: "error",
        message: "失败",
        error: "磁盘空间不足",
        errorCode: "BACKUP_STORAGE_NO_SPACE",
        retryable: false,
      }),
    };

    await expect(runFullBackupJob(client, "sudo-token", undefined, { delay: async () => {} }))
      .rejects.toMatchObject({
        message: "磁盘空间不足",
        code: "BACKUP_STORAGE_NO_SPACE",
        operationId: "job-2",
        retryable: false,
      });
  });
});
