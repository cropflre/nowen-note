export function evaluateCondition(left: unknown, operator: string, right?: unknown): boolean {
  switch (operator) {
    case "equals": return left === right || String(left) === String(right);
    case "not_equals": return !(left === right || String(left) === String(right));
    case "contains": return Array.isArray(left) ? left.some((item) => String(item) === String(right)) : String(left ?? "").includes(String(right ?? ""));
    case "starts_with": return String(left ?? "").startsWith(String(right ?? ""));
    case "ends_with": return String(left ?? "").endsWith(String(right ?? ""));
    case "exists": return left !== undefined && left !== null && left !== "";
    case "greater_than": return Number(left) > Number(right);
    case "less_than": return Number(left) < Number(right);
    default: throw Object.assign(new Error(`不支持的条件操作符: ${operator}`), { code: "AUTOMATION_CONDITION_INVALID" });
  }
}
