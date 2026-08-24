interface SemVer {
  major: number;
  minor: number;
  patch: number;
  prerelease: Array<number | string>;
}

interface Comparator {
  operator: "=" | ">" | ">=" | "<" | "<=" | "^" | "~" | "wildcard";
  version: SemVer;
  wildcardLevel?: "any" | "major" | "minor";
}

const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function parseSemVer(value: string): SemVer | null {
  const match = SEMVER_PATTERN.exec(value);
  if (!match) return null;
  const core = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (core.some((part) => !Number.isSafeInteger(part))) return null;
  const prerelease = match[4] ? match[4].split(".").map((identifier) => {
    if (/^\d+$/.test(identifier)) {
      if (identifier.length > 1 && identifier.startsWith("0")) return null;
      const numeric = Number(identifier);
      return Number.isSafeInteger(numeric) ? numeric : null;
    }
    return identifier;
  }) : [];
  if (prerelease.some((identifier) => identifier === null)) return null;
  return {
    major: core[0],
    minor: core[1],
    patch: core[2],
    prerelease: prerelease as Array<number | string>,
  };
}

function compare(left: SemVer, right: SemVer): number {
  for (const key of ["major", "minor", "patch"] as const) {
    if (left[key] !== right[key]) return left[key] - right[key];
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    return left.prerelease.length === right.prerelease.length ? 0 : left.prerelease.length === 0 ? 1 : -1;
  }
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left.prerelease[index];
    const rightPart = right.prerelease[index];
    if (leftPart === undefined || rightPart === undefined) return leftPart === undefined ? -1 : 1;
    if (leftPart === rightPart) continue;
    if (typeof leftPart === "number" && typeof rightPart === "number") return leftPart - rightPart;
    if (typeof leftPart === "number") return -1;
    if (typeof rightPart === "number") return 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

function parseComparator(value: string): Comparator | null {
  if (value === "*" || /^x$/i.test(value)) {
    return { operator: "wildcard", version: { major: 0, minor: 0, patch: 0, prerelease: [] }, wildcardLevel: "any" };
  }
  const wildcard = /^(0|[1-9]\d*)(?:\.(0|[1-9]\d*|x|\*))?(?:\.(0|[1-9]\d*|x|\*))?$/i.exec(value);
  if (wildcard && (wildcard[2] === undefined || /^(x|\*)$/i.test(wildcard[2]) || wildcard[3] === undefined || /^(x|\*)$/i.test(wildcard[3]))) {
    const minorWildcard = wildcard[2] === undefined || /^(x|\*)$/i.test(wildcard[2]);
    const major = Number(wildcard[1]);
    const minor = minorWildcard ? 0 : Number(wildcard[2]);
    if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor)) return null;
    return {
      operator: "wildcard",
      version: { major, minor, patch: 0, prerelease: [] },
      wildcardLevel: minorWildcard ? "major" : "minor",
    };
  }
  const match = /^(>=|<=|>|<|=|\^|~)?(.+)$/.exec(value);
  if (!match) return null;
  const version = parseSemVer(match[2]);
  return version ? { operator: (match[1] || "=") as Comparator["operator"], version } : null;
}

function upperBound(comparator: Comparator): SemVer {
  const base = comparator.version;
  if (comparator.operator === "~" || comparator.wildcardLevel === "minor") {
    return { major: base.major, minor: base.minor + 1, patch: 0, prerelease: [] };
  }
  if (comparator.operator === "^" && base.major === 0 && base.minor === 0) {
    return { major: 0, minor: 0, patch: base.patch + 1, prerelease: [] };
  }
  if (comparator.operator === "^" && base.major === 0) {
    return { major: 0, minor: base.minor + 1, patch: 0, prerelease: [] };
  }
  return { major: base.major + 1, minor: 0, patch: 0, prerelease: [] };
}

function matchesComparator(version: SemVer, comparator: Comparator): boolean {
  if (comparator.operator === "wildcard") {
    if (comparator.wildcardLevel === "any") return true;
    return compare(version, comparator.version) >= 0 && compare(version, upperBound(comparator)) < 0;
  }
  const comparison = compare(version, comparator.version);
  switch (comparator.operator) {
    case ">=": return comparison >= 0;
    case "<=": return comparison <= 0;
    case ">": return comparison > 0;
    case "<": return comparison < 0;
    case "^":
    case "~": return comparison >= 0 && compare(version, upperBound(comparator)) < 0;
    default: return comparison === 0;
  }
}

function parseAlternatives(range: string): Comparator[][] | null {
  if (typeof range !== "string" || !range.trim()) return null;
  const alternatives: Comparator[][] = [];
  for (const alternative of range.split("||")) {
    const tokens = alternative.trim().split(/[\s,]+/).filter(Boolean);
    if (tokens.length === 0) return null;
    const comparators = tokens.map(parseComparator);
    if (comparators.some((item) => !item)) return null;
    alternatives.push(comparators as Comparator[]);
  }
  return alternatives;
}

export function isValidSemVerRange(range: string): boolean {
  return parseAlternatives(range) !== null;
}

export function semverSatisfies(versionValue: string, range: string): boolean {
  const version = parseSemVer(versionValue);
  const alternatives = parseAlternatives(range);
  if (!version || !alternatives) return false;
  return alternatives.some((comparators) => {
    if (version.prerelease.length > 0) {
      const prereleaseOptIn = comparators.some((comparator) => comparator.version.prerelease.length > 0
        && comparator.version.major === version.major
        && comparator.version.minor === version.minor
        && comparator.version.patch === version.patch);
      if (!prereleaseOptIn) return false;
    }
    return comparators.every((comparator) => matchesComparator(version, comparator));
  });
}
