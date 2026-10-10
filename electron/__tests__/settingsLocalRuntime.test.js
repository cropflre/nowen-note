// Phase 1：Local-first 运行时字段的派生与兼容性。
//
// 这些断言的核心目的不是覆盖代码，而是锁死数据安全边界：
// 旧用户升级后不能出现空数据，也不能被静默改变行为。

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const settings = require("../settings");

function withTempSettings(initial, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-settings-runtime-"));
  try {
    settings.setSettingsPath(dir);
    if (initial !== undefined) {
      fs.writeFileSync(
        path.join(dir, "settings.json"),
        JSON.stringify(initial, null, 2),
        "utf8",
      );
      // setSettingsPath 已清缓存，但初始文件是在那之后写的，需要再清一次。
      settings.setSettingsPath(dir);
    }
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("全新安装默认 full，等价于 runtime=local 且不开启同步", () => {
  withTempSettings(undefined, () => {
    const value = settings.readSettings();
    assert.equal(value.mode, "full");
    assert.equal(value.runtime, "local");
    assert.equal(value.syncEnabled, false);
    assert.equal(value.activeSyncProfileId, null);
    assert.equal(value.liteMigrationStatus, "none");
    assert.equal(value.localLoginHintDismissed, false);
    assert.equal(settings.shouldUseLocalRuntime(value), true);
  });
});

test("本地登录提示在成功后持久化关闭", () => {
  withTempSettings(undefined, (dir) => {
    settings.writeSettings({ localLoginHintDismissed: true });
    settings.setSettingsPath(dir);
    assert.equal(settings.readSettings().localLoginHintDismissed, true);
  });
});

test("Legacy Full 自动等价 runtime=local + syncEnabled=false，无需迁移", () => {
  withTempSettings({ mode: "full", remoteUrl: "" }, () => {
    const value = settings.readSettings();
    assert.equal(value.mode, "full");
    assert.equal(value.runtime, "local");
    assert.equal(value.syncEnabled, false);
    assert.equal(settings.needsLiteMigration(value), false);
  });
});

test("Legacy Lite 保持 runtime=remote，避免升级后看到空知识库", () => {
  withTempSettings({ mode: "lite", remoteUrl: "http://192.168.1.10:3000" }, () => {
    const value = settings.readSettings();
    assert.equal(value.mode, "lite");
    assert.equal(value.runtime, "remote");
    // lite 连着远端，语义上等价于"同步已开启"
    assert.equal(value.syncEnabled, true);
    assert.equal(settings.shouldUseLocalRuntime(value), false);
    assert.equal(settings.needsLiteMigration(value), true);
  });
});

test("Lite 声称 runtime=local 但迁移未完成时必须回退 remote", () => {
  for (const status of ["none", "pending", "running", "failed"]) {
    withTempSettings(
      {
        mode: "lite",
        remoteUrl: "http://192.168.1.10:3000",
        runtime: "local",
        liteMigrationStatus: status,
      },
      () => {
        const value = settings.readSettings();
        assert.equal(value.runtime, "remote", `status=${status} 必须保护性回退`);
        assert.equal(settings.shouldUseLocalRuntime(value), false);
      },
    );
  }
});

test("Lite 迁移完成后才允许 runtime=local", () => {
  withTempSettings(
    {
      mode: "lite",
      remoteUrl: "http://192.168.1.10:3000",
      runtime: "local",
      liteMigrationStatus: "complete",
    },
    () => {
      const value = settings.readSettings();
      assert.equal(value.runtime, "local");
      assert.equal(settings.shouldUseLocalRuntime(value), true);
      assert.equal(settings.needsLiteMigration(value), false);
    },
  );
});

test("full 模式的数据库在本机，runtime 不接受被改成 remote", () => {
  withTempSettings({ mode: "full", remoteUrl: "", runtime: "remote" }, () => {
    const value = settings.readSettings();
    assert.equal(value.runtime, "local");
  });
});

test("lite 缺 URL 时退回 full，运行时字段随之一致", () => {
  withTempSettings({ mode: "lite", remoteUrl: "" }, () => {
    const value = settings.readSettings();
    assert.equal(value.mode, "full");
    assert.equal(value.runtime, "local");
    assert.equal(value.syncEnabled, false);
  });
});

test("非法 runtime / liteMigrationStatus 取值被忽略而不是抛错", () => {
  withTempSettings(
    {
      mode: "full",
      runtime: "cloud",
      liteMigrationStatus: "halfway",
      syncEnabled: "yes",
    },
    () => {
      const value = settings.readSettings();
      assert.equal(value.runtime, "local");
      assert.equal(value.liteMigrationStatus, "none");
      // syncEnabled 非布尔 → 回退到按 mode 派生
      assert.equal(value.syncEnabled, false);
    },
  );
});

test("关闭同步时清空 activeSyncProfileId，避免引擎被误唤醒", () => {
  withTempSettings(
    { mode: "full", syncEnabled: false, activeSyncProfileId: "profile-a" },
    () => {
      const value = settings.readSettings();
      assert.equal(value.syncEnabled, false);
      assert.equal(value.activeSyncProfileId, null);
    },
  );
});

test("开启同步时保留 activeSyncProfileId 并去除空白", () => {
  withTempSettings(
    {
      mode: "lite",
      remoteUrl: "http://192.168.1.10:3000",
      syncEnabled: true,
      activeSyncProfileId: "  profile-b  ",
    },
    () => {
      const value = settings.readSettings();
      assert.equal(value.syncEnabled, true);
      assert.equal(value.activeSyncProfileId, "profile-b");
    },
  );
});

test("写入运行时字段后可持久化读回，且不破坏 legacy 字段", () => {
  withTempSettings({ mode: "lite", remoteUrl: "http://192.168.1.10:3000" }, (dir) => {
    settings.writeSettings({ liteMigrationStatus: "running" });
    // 重新指向同一目录以清空内存缓存，验证真的落盘
    settings.setSettingsPath(dir);
    const value = settings.readSettings();
    assert.equal(value.liteMigrationStatus, "running");
    // legacy 字段必须原样保留，供旧版本与回滚使用
    assert.equal(value.mode, "lite");
    assert.equal(value.remoteUrl, "http://192.168.1.10:3000");
    assert.equal(value.runtime, "remote");

    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf8"));
    assert.equal(onDisk.mode, "lite");
    assert.equal(onDisk.remoteUrl, "http://192.168.1.10:3000");
  });
});

test("settings.json 损坏时回退默认值而不是抛错", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-settings-broken-"));
  try {
    fs.writeFileSync(path.join(dir, "settings.json"), "{ not json", "utf8");
    settings.setSettingsPath(dir);
    const value = settings.readSettings();
    assert.equal(value.mode, "full");
    assert.equal(value.runtime, "local");
    assert.equal(value.syncEnabled, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
