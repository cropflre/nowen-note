import type { TFunction } from "i18next";

export function fileToolError(failure: unknown, t: TFunction): string {
  const code =
    failure && typeof failure === "object" && "code" in failure
      ? String(failure.code)
      : "";
  const keys: Record<string, string> = {
    MOBILE_ASSET_TOOLS_UNSUPPORTED: "nativeUnavailable",
    MOBILE_WORKSPACE_FILES_UNSUPPORTED: "nativeUnavailable",
    FILE_NOT_FOUND: "fileUnavailable",
    IMAGE_UNSUPPORTED: "imageUnsupported",
    IMAGE_UNAVAILABLE: "imageUnavailable",
    IMAGE_SEARCH_BUSY: "searchBusy",
    FILE_SCOPE_MISMATCH: "scopeMismatch",
    FILE_NAME_CONFLICT: "nameConflict",
    INVALID_RENAME: "invalidName",
    INVALID_ASSET_IDS: "invalidName",
    INVALID_CURSOR: "cursorInvalid",
    FORBIDDEN: "forbidden",
  };
  return keys[code]
    ? t(`assetTools.${keys[code]}`)
    : failure instanceof Error
      ? failure.message
      : String(failure);
}
