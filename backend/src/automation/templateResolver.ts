import type { ExecutionVariables } from "./types.js";

function lookup(variables: ExecutionVariables, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = variables;
  for (const part of parts) {
    if (!current || typeof current !== "object" || Array.isArray(current) || !Object.prototype.hasOwnProperty.call(current, part)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export function resolveTemplates(value: unknown, variables: ExecutionVariables, depth = 0): unknown {
  if (depth > 12) throw Object.assign(new Error("模板解析深度超限"), { code: "AUTOMATION_TEMPLATE_INVALID" });
  if (typeof value === "string") {
    const exact = value.match(/^{{\s*([^}]+)\s*}}$/);
    if (exact) return lookup(variables, exact[1].trim());
    return value.replace(/{{\s*([^}]+)\s*}}/g, (_, path: string) => {
      const resolved = lookup(variables, path.trim());
      return resolved == null ? "" : typeof resolved === "string" ? resolved : JSON.stringify(resolved);
    });
  }
  if (Array.isArray(value)) return value.map((item) => resolveTemplates(item, variables, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, resolveTemplates(item, variables, depth + 1)]));
  }
  return value;
}
