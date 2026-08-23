export type ActionResult = { success?: boolean; data?: unknown; text?: string } | unknown;

export interface PluginActionContext<TInput = Record<string, unknown>> {
  input: TInput;
  nowen: NowenHostApi;
}

type HostNamespace = Record<string, (args?: Record<string, unknown>) => Promise<any>>;

export interface NowenHostApi {
  notes: HostNamespace;
  notebooks: HostNamespace;
  tags: HostNamespace;
  tasks: HostNamespace;
  attachments: HostNamespace;
  diary: HostNamespace;
  mindmaps: HostNamespace;
  storage: HostNamespace;
  external: HostNamespace;
}

export interface NowenPluginDefinition {
  activate?(context: { nowen: NowenHostApi }): void | Promise<void>;
  actions: Record<string, (context: PluginActionContext<any>) => ActionResult | Promise<ActionResult>>;
  deactivate?(): void | Promise<void>;
}

export class NowenPluginError extends Error {
  constructor(message: string, readonly code = "PLUGIN_ERROR") {
    super(message);
    this.name = "NowenPluginError";
  }
}

/** 编译期保留完整类型，运行时原样返回，不夹带业务实现或凭证。 */
export function definePlugin<T extends NowenPluginDefinition>(plugin: T): T {
  return plugin;
}
