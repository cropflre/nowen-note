// 此文件由 scripts/generate-plugin-host-api.mjs 根据 packages/nowen-plugin-sdk/error-code-contract.json 生成，请勿手动修改。
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

export type NowenPluginErrorCode = "EXTERNAL_FETCH_DENIED" | "HOST_ARGS_TOO_LARGE" | "HOST_METHOD_NOT_FOUND" | "HOST_METHOD_UNSUPPORTED" | "HOST_RESULT_TOO_LARGE" | "INVALID_ARGUMENT" | "NETWORK_UNAVAILABLE" | "PLUGIN_CANCELLED" | "PLUGIN_CONTRIBUTION_INVALID" | "PLUGIN_DECLARATIVE_NOT_EXECUTABLE" | "PLUGIN_ERROR" | "PLUGIN_PERMISSION_DENIED" | "PLUGIN_PREFLIGHT_FAILED" | "PLUGIN_TIMEOUT" | "PLUGIN_V21_FEATURE_DISABLED" | "RESOURCE_FORBIDDEN" | "RESOURCE_NOT_FOUND";

export interface NowenPluginErrorMetadata {
  code: NowenPluginErrorCode;
  category: string;
  retryable: boolean;
  description: string;
}

export const NOWEN_PLUGIN_ERROR_CONTRACT_VERSION = 1 as const;
export const NOWEN_PLUGIN_ERROR_CATALOG: readonly NowenPluginErrorMetadata[] = deepFreeze([
  {
    "code": "EXTERNAL_FETCH_DENIED",
    "category": "network",
    "retryable": false,
    "description": "Destination is outside the declared network allowlist"
  },
  {
    "code": "HOST_ARGS_TOO_LARGE",
    "category": "budget",
    "retryable": false,
    "description": "Host API arguments exceed the budget"
  },
  {
    "code": "HOST_METHOD_NOT_FOUND",
    "category": "contract",
    "retryable": false,
    "description": "Requested Host API method does not exist"
  },
  {
    "code": "HOST_METHOD_UNSUPPORTED",
    "category": "contract",
    "retryable": false,
    "description": "Host API method is not supported by this API/runtime"
  },
  {
    "code": "HOST_RESULT_TOO_LARGE",
    "category": "budget",
    "retryable": false,
    "description": "Host API result exceeds the budget"
  },
  {
    "code": "INVALID_ARGUMENT",
    "category": "validation",
    "retryable": false,
    "description": "Input does not satisfy the method contract"
  },
  {
    "code": "NETWORK_UNAVAILABLE",
    "category": "network",
    "retryable": true,
    "description": "Network is currently unavailable"
  },
  {
    "code": "PLUGIN_CANCELLED",
    "category": "runtime",
    "retryable": false,
    "description": "Execution was cancelled"
  },
  {
    "code": "PLUGIN_CONTRIBUTION_INVALID",
    "category": "validation",
    "retryable": false,
    "description": "A declarative contribution failed validation"
  },
  {
    "code": "PLUGIN_DECLARATIVE_NOT_EXECUTABLE",
    "category": "runtime",
    "retryable": false,
    "description": "Declarative extensions cannot execute actions"
  },
  {
    "code": "PLUGIN_ERROR",
    "category": "runtime",
    "retryable": false,
    "description": "Unclassified extension failure"
  },
  {
    "code": "PLUGIN_PERMISSION_DENIED",
    "category": "permission",
    "retryable": false,
    "description": "Declared permission is not granted"
  },
  {
    "code": "PLUGIN_PREFLIGHT_FAILED",
    "category": "lifecycle",
    "retryable": false,
    "description": "Extension preflight failed"
  },
  {
    "code": "PLUGIN_TIMEOUT",
    "category": "runtime",
    "retryable": true,
    "description": "Extension execution exceeded its deadline"
  },
  {
    "code": "PLUGIN_V21_FEATURE_DISABLED",
    "category": "feature-gate",
    "retryable": false,
    "description": "V2.1 capability is disabled by the host"
  },
  {
    "code": "RESOURCE_FORBIDDEN",
    "category": "permission",
    "retryable": false,
    "description": "Invoker cannot access the requested resource"
  },
  {
    "code": "RESOURCE_NOT_FOUND",
    "category": "resource",
    "retryable": false,
    "description": "Requested resource does not exist"
  }
]);
