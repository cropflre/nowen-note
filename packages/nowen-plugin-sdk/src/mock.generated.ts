// 此文件由 scripts/generate-plugin-host-api.mjs 根据 packages/nowen-plugin-sdk/host-api-contract.json 生成，请勿手动修改。
import { HOST_API_CONTRACT, type HostApiMethod } from "./hostApi.generated.js";

export type HostApiMockHandler = (input: unknown) => unknown | Promise<unknown>;
export type HostApiMockOverrides = Partial<Record<HostApiMethod, HostApiMockHandler>>;

export interface HostApiCallMock {
  readonly methods: readonly HostApiMethod[];
  readonly calls: ReadonlyArray<{ method: HostApiMethod; input: unknown }>;
  call(method: HostApiMethod, input?: unknown): Promise<unknown>;
  reset(): void;
}

export function createHostApiCallMock(overrides: HostApiMockOverrides = {}): HostApiCallMock {
  const calls: Array<{ method: HostApiMethod; input: unknown }> = [];
  const allowed = new Set<HostApiMethod>(HOST_API_CONTRACT.map((entry) => entry.method));
  return {
    methods: [
  "attachments.get",
  "attachments.list",
  "diary.create",
  "diary.get",
  "diary.list",
  "external.fetch",
  "mindmaps.create",
  "mindmaps.get",
  "mindmaps.list",
  "mindmaps.update",
  "notebooks.create",
  "notebooks.get",
  "notebooks.list",
  "notes.create",
  "notes.get",
  "notes.list",
  "notes.update",
  "runtime.capabilities",
  "storage.delete",
  "storage.get",
  "storage.set",
  "tags.addToNote",
  "tags.create",
  "tags.list",
  "tags.removeFromNote",
  "tasks.create",
  "tasks.get",
  "tasks.list",
  "tasks.update"
] as readonly HostApiMethod[],
    get calls() { return calls; },
    async call(method, input = {}) {
      if (!allowed.has(method)) throw new Error("Mock Host API 方法不存在: " + method);
      calls.push({ method, input });
      const handler = overrides[method];
      if (!handler) throw new Error("Mock Host API 未配置处理器: " + method);
      return handler(input);
    },
    reset() { calls.length = 0; },
  };
}
