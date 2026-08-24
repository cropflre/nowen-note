import fs from "node:fs";
import path from "node:path";
import { getQuickJS, shouldInterruptAfterDeadline, type QuickJSContext, type QuickJSRuntime } from "quickjs-emscripten";
import type { ExecutionLogTail } from "./logs.js";
import type { HostCall, PluginExecutionContext, PluginExecutionResult, PluginProgress, PluginRegistryRecord } from "./types.js";

type HostCallHandler = (context: PluginExecutionContext, call: HostCall) => Promise<unknown>;
type ProgressHandler = (executionId: string, progress: PluginProgress) => void;

const HOST_CALL_LIMIT = 1000;
const BOOTSTRAP = `
globalThis.process = undefined; globalThis.require = undefined; globalThis.fetch = undefined;
globalThis.Buffer = undefined; globalThis.WebSocket = undefined; globalThis.XMLHttpRequest = undefined;
const __call = (method, args) => __nowenHostCall(method, JSON.stringify(args || {})).then(JSON.parse);
globalThis.nowen = Object.freeze({
 notes:{get:a=>__call('notes.get',a),list:a=>__call('notes.list',a),create:a=>__call('notes.create',a),update:a=>__call('notes.update',a)},
 notebooks:{get:a=>__call('notebooks.get',a),list:a=>__call('notebooks.list',a),create:a=>__call('notebooks.create',a)},
 tags:{list:a=>__call('tags.list',a),create:a=>__call('tags.create',a),addToNote:a=>__call('tags.addToNote',a),removeFromNote:a=>__call('tags.removeFromNote',a)},
 tasks:{get:a=>__call('tasks.get',a),list:a=>__call('tasks.list',a),create:a=>__call('tasks.create',a),update:a=>__call('tasks.update',a)},
 attachments:{get:a=>__call('attachments.get',a),list:a=>__call('attachments.list',a)},
 diary:{get:a=>__call('diary.get',a),list:a=>__call('diary.list',a),create:a=>__call('diary.create',a)},
 mindmaps:{get:a=>__call('mindmaps.get',a),list:a=>__call('mindmaps.list',a),create:a=>__call('mindmaps.create',a),update:a=>__call('mindmaps.update',a)},
 storage:{get:a=>__call('storage.get',a),set:a=>__call('storage.set',a),delete:a=>__call('storage.delete',a)},
 external:{fetch:a=>__call('external.fetch',a)}, runtime:{capabilities:()=>__call('runtime.capabilities',{})},
 progress:(value)=>__nowenProgress(JSON.stringify(value || {}))
});`;

export class SandboxRunner {
  private active = new Map<string, { runtime: QuickJSRuntime; context: QuickJSContext }>();
  constructor(private readonly record: PluginRegistryRecord, private readonly hostCallHandler: HostCallHandler, private readonly progressHandler: ProgressHandler = () => undefined) {}

  private source(): string {
    const target = path.resolve(this.record.installedPath, this.record.main);
    const relative = path.relative(path.resolve(this.record.installedPath), target);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Sandbox 入口路径逃逸");
    return fs.readFileSync(target, "utf8");
  }

  private async create(context: PluginExecutionContext, timeoutMs: number): Promise<{ runtime: QuickJSRuntime; vm: QuickJSContext }> {
    const QuickJS = await getQuickJS();
    const runtime = QuickJS.newRuntime();
    runtime.setMemoryLimit(64 * 1024 * 1024);
    runtime.setMaxStackSize(512 * 1024);
    runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + timeoutMs));
    const vm = runtime.newContext();
    let calls = 0;
    const host = vm.newFunction("__nowenHostCall", (methodHandle, argsHandle) => {
      const method = vm.getString(methodHandle);
      const args = JSON.parse(vm.getString(argsHandle));
      const deferred = vm.newPromise();
      if (++calls > HOST_CALL_LIMIT) { const handle = vm.newError("Host API 调用次数超过限制"); deferred.reject(handle); handle.dispose(); }
      else void this.hostCallHandler(context, { method, args }).then(
        (value) => { const handle = vm.newString(JSON.stringify(value ?? null)); deferred.resolve(handle); handle.dispose(); },
        (error) => { const handle = vm.newError((error as Error).message); deferred.reject(handle); handle.dispose(); },
      );
      deferred.settled.then(() => { try { runtime.executePendingJobs(); } catch { /* surfaced by resolvePromise */ } finally { deferred.dispose(); } });
      return deferred.handle;
    });
    vm.setProp(vm.global, "__nowenHostCall", host); host.dispose();
    const progress = vm.newFunction("__nowenProgress", (valueHandle) => {
      this.progressHandler(context.executionId, JSON.parse(vm.getString(valueHandle)));
    });
    vm.setProp(vm.global, "__nowenProgress", progress); progress.dispose();
    const boot = vm.evalCode(`${BOOTSTRAP}\n${this.source()}\n;if(!globalThis.__nowenPluginModule) throw new Error('sandbox bundle must define globalThis.__nowenPluginModule');`, this.record.main);
    vm.unwrapResult(boot).dispose();
    this.active.set(context.executionId, { runtime, context: vm });
    return { runtime, vm };
  }

  async execute(context: PluginExecutionContext, input: Record<string, unknown>, timeoutMs: number, logs: ExecutionLogTail): Promise<PluginExecutionResult> {
    let runtime: QuickJSRuntime | undefined; let vm: QuickJSContext | undefined;
    try {
      ({ runtime, vm } = await this.create(context, timeoutMs));
      const action = JSON.stringify(context.actionId); const payload = JSON.stringify(input);
      const evaluation = vm.evalCode(`(async()=>{const root=globalThis.__nowenPluginModule;const m=root.default||root;const fn=(m.actions&&m.actions[${action}])||m[${action}];if(typeof fn!=='function')throw new Error('Action 不存在');return JSON.stringify(await fn({input:${payload},nowen:globalThis.nowen,execution:{executionId:${JSON.stringify(context.executionId)}}}));})()`);
      const promise = vm.unwrapResult(evaluation);
      const resolved = await vm.resolvePromise(promise); promise.dispose();
      const valueHandle = vm.unwrapResult(resolved);
      const serialized = vm.getString(valueHandle); valueHandle.dispose();
      const value = JSON.parse(serialized || "null");
      return value && typeof value === "object" && "success" in value ? value : { success: true, data: value };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logs.add("error", message);
      const code = /interrupted/i.test(message) ? "PLUGIN_TIMEOUT" : /memory|out of memory/i.test(message) ? "PLUGIN_MEMORY_LIMIT" : "PLUGIN_SANDBOX_FAILED";
      throw Object.assign(new Error(message), { code });
    } finally {
      this.active.delete(context.executionId);
      try { vm?.dispose(); } catch { /* already disposed */ }
      try { runtime?.dispose(); } catch { /* already disposed */ }
    }
  }

  async preflight(): Promise<void> {
    const context: PluginExecutionContext = { executionId: `preflight-${this.record.id}`, pluginId: this.record.id, actionId: "preflight", userId: "system", workspaceId: null, source: "system" };
    const { runtime, vm } = await this.create(context, 5000);
    try {
      const actionIds = (JSON.parse(this.record.manifestJson).actions || []).map((item: { id: string }) => item.id);
      const check = vm.evalCode(`(()=>{const root=globalThis.__nowenPluginModule;const m=root.default||root;const a=m.actions||m;return ${JSON.stringify(actionIds)}.every(id=>typeof a[id]==='function')})()`);
      const handle = vm.unwrapResult(check); const valid = vm.dump(handle) === true; handle.dispose();
      if (!valid) throw new Error("Sandbox bundle 缺少声明的 Action");
    } finally { this.active.delete(context.executionId); vm.dispose(); runtime.dispose(); }
  }

  cancel(executionId: string): boolean {
    const active = this.active.get(executionId); if (!active) return false;
    active.runtime.setInterruptHandler(() => true); return true;
  }
  async terminate(): Promise<void> { for (const active of this.active.values()) active.runtime.setInterruptHandler(() => true); }
}
