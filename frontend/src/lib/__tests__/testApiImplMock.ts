/**
 * 组件测试专用的 `@/lib/api.impl` 完整 mock（PERF-TASKOFFLINE-01配套）
 * ---------------------------------------------------------------------------
 * 背景：
 *   `installTaskOfflineApi`（frontend/src/lib/taskOfflineRuntime.ts）在生产环境
 *   要求传入的 api 对象具备 NATIVE_METHODS 里列出的全部 14 个任务/习惯方法，
 *   缺失时直接抛错（测试环境才允许降级为 no-op）。
 *
 *   多个 TiptapBlockPatch*.test.tsx 之前各自手写了一份只含 7 个方法的
 *   `@/lib/api.impl` mock，是在依赖"生产环境静默降级"这条已被收紧的路径。
 *   现在改为从这里统一取一份完整 mock，任何新增/改名的 NATIVE_METHODS 只需
 *   改这一处，不用逐个测试文件补齐。
 *
 * 用法：
 *   vi.mock("@/lib/api.impl", () => createApiImplMock());
 *   // 或带 overrides：
 *   vi.mock("@/lib/api.impl", () => createApiImplMock({ api: { search: async () => [...] } }));
 */

/** 返回值形态与 taskOfflineRuntime.ts 里的 NativeApi 一致，供离线队列安装用。 */
function createTaskHabitApiStub() {
  return {
    getTasks: async () => [],
    getTaskStats: async () => ({
      total: 0, completed: 0, pending: 0, today: 0, overdue: 0, week: 0,
    }),
    createTask: async () => ({}),
    updateTask: async () => ({ task: {}, generatedTask: null }),
    toggleTask: async () => ({ task: {}, generatedTask: null }),
    deleteTask: async () => ({ success: true }),
    getHabits: async () => [],
    getHabitStats: async () => ({
      totalCheckins: 0, checkinDays: 0, currentStreak: 0,
      successCount: 0, partialCount: 0, failureCount: 0, habitCount: 0,
    }),
    getHabitCheckinLog: async () => [],
    createHabit: async () => ({}),
    updateHabit: async () => ({}),
    archiveHabit: async () => ({}),
    deleteHabit: async () => ({ success: true }),
    checkInHabit: async () => ({}),
  };
}

/** 组件测试常用到的其它api.impl 方法（附件上传/搜索/笔记本操作）。 */
function createMiscApiStub() {
  return {
    attachments: { upload: async () => ({}) },
    search: async () => [],
    moveNotebook: async () => ({}),
    reorderNotebooks: async () => ({}),
    updateNotebook: async () => ({}),
  };
}

interface ApiImplMockOverrides {
  api?: Record<string, unknown>;
  getBaseUrl?: () => string;
  getCurrentWorkspace?: () => unknown;
  getServerUrl?: () => string;
}

/**
 * 生成完整的 `@/lib/api.impl` mock 模块。
 *
 * `api` 字段始终包含全部 NATIVE_METHODS，避免 installTaskOfflineApi 在生产
 * 契约检查下抛错；`overrides.api` 里的字段会覆盖对应的默认实现（浅合并）。
 */
export function createApiImplMock(overrides: ApiImplMockOverrides = {}) {
  return {
    api: {
      ...createMiscApiStub(),
      ...createTaskHabitApiStub(),
      ...(overrides.api || {}),
    },
    getBaseUrl: overrides.getBaseUrl || (() => "/api"),
    getCurrentWorkspace: overrides.getCurrentWorkspace || (() => null),
    getServerUrl: overrides.getServerUrl || (() => ""),
  };
}
