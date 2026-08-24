import {
  HOST_API_BUDGETS,
  HOST_API_CONTRACT,
  HOST_API_CONTRACT_VERSION,
  V2_SUPPORTED_PLUGIN_PERMISSIONS,
} from "./hostApiContract.generated.js";
import type { PluginPermission } from "./types.js";

export type HostRuntime = "node-action" | "sandbox-js";

export interface HostApiContractEntry {
  method: string;
  sinceApiVersion: 1 | 2;
  permission: PluginPermission | null;
  runtimes: readonly HostRuntime[];
  maxArgsBytes: number;
  maxResultBytes: number;
}

export {
  HOST_API_BUDGETS,
  HOST_API_CONTRACT,
  HOST_API_CONTRACT_VERSION,
  V2_SUPPORTED_PLUGIN_PERMISSIONS,
};

const methods = new Map<string, HostApiContractEntry>(
  HOST_API_CONTRACT.map((entry) => [entry.method, entry]),
);
const v2SupportedPermissions = new Set<PluginPermission>(V2_SUPPORTED_PLUGIN_PERMISSIONS);

function hostMethodError(method: string, code: "HOST_METHOD_NOT_FOUND" | "HOST_METHOD_UNSUPPORTED", message: string): Error {
  return Object.assign(new Error(`${message}: ${method}`), { code });
}

export function requireHostMethod(
  method: string,
  apiVersion: 1 | 2,
  runtime: HostRuntime,
): HostApiContractEntry {
  const entry = methods.get(method);
  if (!entry) {
    throw hostMethodError(method, "HOST_METHOD_NOT_FOUND", "Host API 方法不存在");
  }
  if (apiVersion < entry.sinceApiVersion || !entry.runtimes.includes(runtime)) {
    throw hostMethodError(method, "HOST_METHOD_UNSUPPORTED", `Host API 方法不支持 API V${apiVersion}/${runtime}`);
  }
  return entry;
}

export function isV2SupportedPluginPermission(permission: string): permission is PluginPermission {
  return v2SupportedPermissions.has(permission as PluginPermission);
}

export function createHostMethodNotFound(method: string): Error {
  return hostMethodError(method, "HOST_METHOD_NOT_FOUND", "Host API 方法不存在");
}
