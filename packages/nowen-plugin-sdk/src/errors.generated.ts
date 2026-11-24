// 此文件由 scripts/generate-plugin-host-api.mjs 根据 packages/nowen-plugin-sdk/error-code-contract.json 生成，请勿手动修改。
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

export type NowenPluginErrorCode = "CAPTURE_EXTRACTION_FAILED" | "CAPTURE_FETCH_FAILED" | "CAPTURE_TOO_LARGE" | "CAPTURE_URL_DENIED" | "EXTERNAL_FETCH_DENIED" | "EXTERNAL_FETCH_DNS_ERROR" | "EXTERNAL_FETCH_INVALID_REDIRECT" | "EXTERNAL_FETCH_INVALID_URL" | "EXTERNAL_FETCH_NETWORK_ERROR" | "EXTERNAL_FETCH_REDIRECT_LIMIT" | "EXTERNAL_FETCH_RESPONSE_TOO_LARGE" | "EXTERNAL_FETCH_TIMEOUT" | "HOST_ARGS_TOO_LARGE" | "HOST_METHOD_NOT_FOUND" | "HOST_METHOD_UNSUPPORTED" | "HOST_RESULT_TOO_LARGE" | "INVALID_ARGUMENT" | "NETWORK_UNAVAILABLE" | "PLUGIN_ACTION_MISMATCH" | "PLUGIN_CANCELLED" | "PLUGIN_CONTRIBUTION_INVALID" | "PLUGIN_DATA_BACKUP_MISSING" | "PLUGIN_DATA_CONFLICT" | "PLUGIN_DATA_DISABLED" | "PLUGIN_DATA_INVALID" | "PLUGIN_DATA_QUOTA_EXCEEDED" | "PLUGIN_DECLARATIVE_NOT_EXECUTABLE" | "PLUGIN_EDITOR_ACTIONS_DISABLED" | "PLUGIN_EDITOR_ACTION_BUSY" | "PLUGIN_EDITOR_ACTION_INVALID_RESULT" | "PLUGIN_EDITOR_ACTION_NOT_FOUND" | "PLUGIN_EDITOR_ACTION_UNSUPPORTED" | "PLUGIN_EDITOR_AI_FAILED" | "PLUGIN_EDITOR_AI_NOT_CONFIGURED" | "PLUGIN_EDITOR_NOTE_FORBIDDEN" | "PLUGIN_EDITOR_NOTE_PROTECTED" | "PLUGIN_ERROR" | "PLUGIN_PERMISSION_DENIED" | "PLUGIN_PREFLIGHT_FAILED" | "PLUGIN_TIMEOUT" | "PLUGIN_UI_FEATURE_DISABLED" | "PLUGIN_V21_FEATURE_DISABLED" | "RESOURCE_FORBIDDEN" | "RESOURCE_NOT_FOUND";

export interface NowenPluginErrorMetadata {
  code: NowenPluginErrorCode;
  category: string;
  retryable: boolean;
  description: string;
}

export const NOWEN_PLUGIN_ERROR_CONTRACT_VERSION = 2 as const;
export const NOWEN_PLUGIN_ERROR_CATALOG: readonly NowenPluginErrorMetadata[] = deepFreeze([
  {
    "code": "CAPTURE_EXTRACTION_FAILED",
    "category": "validation",
    "retryable": false,
    "description": "No readable HTML article was found"
  },
  {
    "code": "CAPTURE_FETCH_FAILED",
    "category": "network",
    "retryable": true,
    "description": "Public article capture failed at the network layer"
  },
  {
    "code": "CAPTURE_TOO_LARGE",
    "category": "budget",
    "retryable": false,
    "description": "Capture exceeds the article content budget"
  },
  {
    "code": "CAPTURE_URL_DENIED",
    "category": "network",
    "retryable": false,
    "description": "Capture URL is invalid or resolves to a non-public address"
  },
  {
    "code": "EXTERNAL_FETCH_DENIED",
    "category": "network",
    "retryable": false,
    "description": "Destination is outside the declared network allowlist"
  },
  {
    "code": "EXTERNAL_FETCH_DNS_ERROR",
    "category": "network",
    "retryable": true,
    "description": "External fetch DNS resolution failed"
  },
  {
    "code": "EXTERNAL_FETCH_INVALID_REDIRECT",
    "category": "network",
    "retryable": false,
    "description": "External fetch redirect target is invalid or unsafe"
  },
  {
    "code": "EXTERNAL_FETCH_INVALID_URL",
    "category": "network",
    "retryable": false,
    "description": "External fetch URL is invalid or unsafe"
  },
  {
    "code": "EXTERNAL_FETCH_NETWORK_ERROR",
    "category": "network",
    "retryable": true,
    "description": "External fetch failed at the network layer"
  },
  {
    "code": "EXTERNAL_FETCH_REDIRECT_LIMIT",
    "category": "network",
    "retryable": false,
    "description": "External fetch exceeded the redirect limit"
  },
  {
    "code": "EXTERNAL_FETCH_RESPONSE_TOO_LARGE",
    "category": "budget",
    "retryable": false,
    "description": "External fetch response exceeds the configured budget"
  },
  {
    "code": "EXTERNAL_FETCH_TIMEOUT",
    "category": "network",
    "retryable": true,
    "description": "External fetch exceeded its deadline"
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
    "code": "PLUGIN_ACTION_MISMATCH",
    "category": "contract",
    "retryable": false,
    "description": "Runtime actions do not match the manifest contract"
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
    "code": "PLUGIN_DATA_BACKUP_MISSING",
    "category": "validation",
    "retryable": false,
    "description": "No collection migration snapshot is available"
  },
  {
    "code": "PLUGIN_DATA_CONFLICT",
    "category": "validation",
    "retryable": false,
    "description": "Record, schema or snapshot changed; reload before retrying"
  },
  {
    "code": "PLUGIN_DATA_DISABLED",
    "category": "validation",
    "retryable": false,
    "description": "Structured plugin data is disabled"
  },
  {
    "code": "PLUGIN_DATA_INVALID",
    "category": "validation",
    "retryable": false,
    "description": "Invalid structured data input"
  },
  {
    "code": "PLUGIN_DATA_QUOTA_EXCEEDED",
    "category": "validation",
    "retryable": false,
    "description": "Plugin data capacity or record budget exceeded"
  },
  {
    "code": "PLUGIN_DECLARATIVE_NOT_EXECUTABLE",
    "category": "runtime",
    "retryable": false,
    "description": "Declarative extensions cannot execute actions"
  },
  {
    "code": "PLUGIN_EDITOR_ACTIONS_DISABLED",
    "category": "feature-gate",
    "retryable": false,
    "description": "Editor actions are disabled by the host"
  },
  {
    "code": "PLUGIN_EDITOR_ACTION_BUSY",
    "category": "budget",
    "retryable": true,
    "description": "Too many editor actions are running for this user"
  },
  {
    "code": "PLUGIN_EDITOR_ACTION_INVALID_RESULT",
    "category": "contract",
    "retryable": false,
    "description": "The editor action returned an invalid or oversized result"
  },
  {
    "code": "PLUGIN_EDITOR_ACTION_NOT_FOUND",
    "category": "resource",
    "retryable": false,
    "description": "The editor action is not declared by an enabled plugin"
  },
  {
    "code": "PLUGIN_EDITOR_ACTION_UNSUPPORTED",
    "category": "contract",
    "retryable": false,
    "description": "The editor action does not support this editor or selection"
  },
  {
    "code": "PLUGIN_EDITOR_AI_FAILED",
    "category": "runtime",
    "retryable": true,
    "description": "The AI model request for a prompt editor action failed"
  },
  {
    "code": "PLUGIN_EDITOR_AI_NOT_CONFIGURED",
    "category": "feature-gate",
    "retryable": false,
    "description": "Prompt editor actions need an enabled and configured AI model"
  },
  {
    "code": "PLUGIN_EDITOR_NOTE_FORBIDDEN",
    "category": "permission",
    "retryable": false,
    "description": "The current user cannot run this editor action on the note"
  },
  {
    "code": "PLUGIN_EDITOR_NOTE_PROTECTED",
    "category": "permission",
    "retryable": false,
    "description": "Locked, encrypted or password-protected content is never sent to editor actions"
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
    "code": "PLUGIN_UI_FEATURE_DISABLED",
    "category": "feature-gate",
    "retryable": false,
    "description": "UI contributions are disabled by the host"
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
