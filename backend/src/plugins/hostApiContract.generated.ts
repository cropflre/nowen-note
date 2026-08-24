// 此文件由 scripts/generate-plugin-host-api.mjs 根据 packages/nowen-plugin-sdk/host-api-contract.json 生成，请勿手动修改。
import type { PluginPermission } from "./types.js";
import type { HostApiContractEntry } from "./hostApiContract.js";

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

export const HOST_API_CONTRACT_VERSION = 1 as const;

export const HOST_API_BUDGETS = deepFreeze({
  "ipcMessageBytes": 2097152,
  "hostCallArgsBytes": 262144,
  "hostCallResultBytes": 1048576
} as const);

export const HOST_API_CONTRACT = deepFreeze([
  {
    "method": "attachments.get",
    "sinceApiVersion": 1,
    "permission": "attachments:read",
    "runtimes": [
      "node-action",
      "sandbox-js"
    ],
    "maxArgsBytes": 262144,
    "maxResultBytes": 1048576
  },
  {
    "method": "attachments.list",
    "sinceApiVersion": 1,
    "permission": "attachments:read",
    "runtimes": [
      "node-action",
      "sandbox-js"
    ],
    "maxArgsBytes": 262144,
    "maxResultBytes": 1048576
  },
  {
    "method": "diary.create",
    "sinceApiVersion": 1,
    "permission": "diary:write",
    "runtimes": [
      "node-action",
      "sandbox-js"
    ],
    "maxArgsBytes": 262144,
    "maxResultBytes": 1048576
  },
  {
    "method": "diary.get",
    "sinceApiVersion": 1,
    "permission": "diary:read",
    "runtimes": [
      "node-action",
      "sandbox-js"
    ],
    "maxArgsBytes": 262144,
    "maxResultBytes": 1048576
  },
  {
    "method": "diary.list",
    "sinceApiVersion": 1,
    "permission": "diary:read",
    "runtimes": [
      "node-action",
      "sandbox-js"
    ],
    "maxArgsBytes": 262144,
    "maxResultBytes": 1048576
  },
  {
    "method": "external.fetch",
    "sinceApiVersion": 1,
    "permission": "external:fetch",
    "runtimes": [
      "node-action",
      "sandbox-js"
    ],
    "maxArgsBytes": 262144,
    "maxResultBytes": 1048576
  },
  {
    "method": "mindmaps.create",
    "sinceApiVersion": 1,
    "permission": "mindmaps:write",
    "runtimes": [
      "node-action",
      "sandbox-js"
    ],
    "maxArgsBytes": 262144,
    "maxResultBytes": 1048576
  },
  {
    "method": "mindmaps.get",
    "sinceApiVersion": 1,
    "permission": "mindmaps:read",
    "runtimes": [
      "node-action",
      "sandbox-js"
    ],
    "maxArgsBytes": 262144,
    "maxResultBytes": 1048576
  },
  {
    "method": "mindmaps.list",
    "sinceApiVersion": 1,
    "permission": "mindmaps:read",
    "runtimes": [
      "node-action",
      "sandbox-js"
    ],
    "maxArgsBytes": 262144,
    "maxResultBytes": 1048576
  },
  {
    "method": "mindmaps.update",
    "sinceApiVersion": 1,
    "permission": "mindmaps:write",
    "runtimes": [
      "node-action",
      "sandbox-js"
    ],
    "maxArgsBytes": 262144,
    "maxResultBytes": 1048576
  },
  {
    "method": "notebooks.create",
    "sinceApiVersion": 1,
    "permission": "notebooks:write",
    "runtimes": [
      "node-action",
      "sandbox-js"
    ],
    "maxArgsBytes": 262144,
    "maxResultBytes": 1048576
  },
  {
    "method": "notebooks.get",
    "sinceApiVersion": 1,
    "permission": "notebooks:read",
    "runtimes": [
      "node-action",
      "sandbox-js"
    ],
    "maxArgsBytes": 262144,
    "maxResultBytes": 1048576
  },
  {
    "method": "notebooks.list",
    "sinceApiVersion": 1,
    "permission": "notebooks:read",
    "runtimes": [
      "node-action",
      "sandbox-js"
    ],
    "maxArgsBytes": 262144,
    "maxResultBytes": 1048576
  },
  {
    "method": "notes.create",
    "sinceApiVersion": 1,
    "permission": "notes:write",
    "runtimes": [
      "node-action",
      "sandbox-js"
    ],
    "maxArgsBytes": 262144,
    "maxResultBytes": 1048576
  },
  {
    "method": "notes.get",
    "sinceApiVersion": 1,
    "permission": "notes:read",
    "runtimes": [
      "node-action",
      "sandbox-js"
    ],
    "maxArgsBytes": 262144,
    "maxResultBytes": 1048576
  },
  {
    "method": "notes.list",
    "sinceApiVersion": 1,
    "permission": "notes:read",
    "runtimes": [
      "node-action",
      "sandbox-js"
    ],
    "maxArgsBytes": 262144,
    "maxResultBytes": 1048576
  },
  {
    "method": "notes.update",
    "sinceApiVersion": 1,
    "permission": "notes:write",
    "runtimes": [
      "node-action",
      "sandbox-js"
    ],
    "maxArgsBytes": 262144,
    "maxResultBytes": 1048576
  },
  {
    "method": "runtime.capabilities",
    "sinceApiVersion": 1,
    "permission": null,
    "runtimes": [
      "node-action",
      "sandbox-js"
    ],
    "maxArgsBytes": 262144,
    "maxResultBytes": 1048576
  },
  {
    "method": "storage.delete",
    "sinceApiVersion": 1,
    "permission": "plugin-storage:write",
    "runtimes": [
      "node-action",
      "sandbox-js"
    ],
    "maxArgsBytes": 262144,
    "maxResultBytes": 1048576
  },
  {
    "method": "storage.get",
    "sinceApiVersion": 1,
    "permission": "plugin-storage:read",
    "runtimes": [
      "node-action",
      "sandbox-js"
    ],
    "maxArgsBytes": 262144,
    "maxResultBytes": 1048576
  },
  {
    "method": "storage.set",
    "sinceApiVersion": 1,
    "permission": "plugin-storage:write",
    "runtimes": [
      "node-action",
      "sandbox-js"
    ],
    "maxArgsBytes": 262144,
    "maxResultBytes": 1048576
  },
  {
    "method": "tags.addToNote",
    "sinceApiVersion": 1,
    "permission": "tags:write",
    "runtimes": [
      "node-action",
      "sandbox-js"
    ],
    "maxArgsBytes": 262144,
    "maxResultBytes": 1048576
  },
  {
    "method": "tags.create",
    "sinceApiVersion": 1,
    "permission": "tags:write",
    "runtimes": [
      "node-action",
      "sandbox-js"
    ],
    "maxArgsBytes": 262144,
    "maxResultBytes": 1048576
  },
  {
    "method": "tags.list",
    "sinceApiVersion": 1,
    "permission": "tags:read",
    "runtimes": [
      "node-action",
      "sandbox-js"
    ],
    "maxArgsBytes": 262144,
    "maxResultBytes": 1048576
  },
  {
    "method": "tags.removeFromNote",
    "sinceApiVersion": 1,
    "permission": "tags:write",
    "runtimes": [
      "node-action",
      "sandbox-js"
    ],
    "maxArgsBytes": 262144,
    "maxResultBytes": 1048576
  },
  {
    "method": "tasks.create",
    "sinceApiVersion": 1,
    "permission": "tasks:write",
    "runtimes": [
      "node-action",
      "sandbox-js"
    ],
    "maxArgsBytes": 262144,
    "maxResultBytes": 1048576
  },
  {
    "method": "tasks.get",
    "sinceApiVersion": 1,
    "permission": "tasks:read",
    "runtimes": [
      "node-action",
      "sandbox-js"
    ],
    "maxArgsBytes": 262144,
    "maxResultBytes": 1048576
  },
  {
    "method": "tasks.list",
    "sinceApiVersion": 1,
    "permission": "tasks:read",
    "runtimes": [
      "node-action",
      "sandbox-js"
    ],
    "maxArgsBytes": 262144,
    "maxResultBytes": 1048576
  },
  {
    "method": "tasks.update",
    "sinceApiVersion": 1,
    "permission": "tasks:write",
    "runtimes": [
      "node-action",
      "sandbox-js"
    ],
    "maxArgsBytes": 262144,
    "maxResultBytes": 1048576
  }
] as const) satisfies readonly HostApiContractEntry[];

export const V2_COMBINATION_PLUGIN_PERMISSIONS = deepFreeze([
  "secrets:use"
] as const) satisfies readonly PluginPermission[];

export const V2_SUPPORTED_PLUGIN_PERMISSIONS = deepFreeze([
  "attachments:read",
  "diary:read",
  "diary:write",
  "external:fetch",
  "mindmaps:read",
  "mindmaps:write",
  "notebooks:read",
  "notebooks:write",
  "notes:read",
  "notes:write",
  "plugin-storage:read",
  "plugin-storage:write",
  "secrets:use",
  "tags:read",
  "tags:write",
  "tasks:read",
  "tasks:write"
] as const) satisfies readonly PluginPermission[];
