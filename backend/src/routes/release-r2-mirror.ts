/**
 * Official R2 download mirror verification for Settings > Download clients.
 * R2 manifest is published only after all selected assets pass verification.
 */
const R2_ORIGIN = "https://download.nowen.cn";
const OFFICIAL_RELEASE_PREFIX = "https://github.com/cropflre/nowen-note/releases/download/";
const TAG_PATTERN = /^v\d+\.\d+\.\d+$/;

export type GithubMirrorAsset = {
  name: string;
  size: number;
  browserDownloadUrl: string;
};
export type GithubMirrorRelease = {
  tag: string;
  draft: boolean;
  prerelease: boolean;
  assets: GithubMirrorAsset[];
};
export type VerifiedMirrorAsset = { name: string; size: number; downloadUrl: string };
export type VerifiedMirrorResult =
  | { available: true; tag: string; assets: VerifiedMirrorAsset[] }
  | { available: false; tag: string };

export function isMirrorEligibleName(name: string, tag: string): boolean {
  if (!TAG_PATTERN.test(tag)) return false;
  const version = tag.slice(1);
  return [
    "Nowen-Note-" + version + "-setup.exe",
    "Nowen-Note-" + version + "-arm64.dmg",
    "Nowen-Note-" + version + "-x64.dmg",
    "Nowen-Note-" + version + "-x86_64.AppImage",
    "Nowen-Note-" + version + "-amd64.deb",
    "Nowen-Note-" + version + ".apk",
    "nowen-note-" + version + "-fpk-r1.fpk",
    "nowen-note-" + version + ".fpk"
  ].includes(name) || /^nowen-clipper-\d+\.\d+\.\d+(?:-(?:edge|firefox))?\.zip$/.test(name);
}

export function validateMirrorManifest(
  release: GithubMirrorRelease,
  raw: unknown,
): VerifiedMirrorResult {
  const unavailable: VerifiedMirrorResult = { available: false, tag: release.tag };
  if (!TAG_PATTERN.test(release.tag) || release.draft || release.prerelease) return unavailable;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return unavailable;
  const manifest = raw as { schema?: unknown; version?: unknown; assets?: unknown };
  if (manifest.schema !== 1 || manifest.version !== release.tag ||
      !Array.isArray(manifest.assets) || manifest.assets.length !== 10) return unavailable;

  const original = new Map(release.assets.map(a => [a.name, a]));
  const seen = new Set<string>();
  const result: VerifiedMirrorAsset[] = [];
  for (const row of manifest.assets) {
    if (!row || typeof row !== "object" || Array.isArray(row)) return unavailable;
    const { name, size } = row as { name?: unknown; size?: unknown };
    if (typeof name !== "string" || typeof size !== "number" ||
      !Number.isSafeInteger(size) || size <= 0 ||
      !isMirrorEligibleName(name, release.tag) || seen.has(name)) return unavailable;
    const github = original.get(name);
    if (!github || github.size !== size || github.browserDownloadUrl !==
      OFFICIAL_RELEASE_PREFIX + release.tag + "/" + encodeURIComponent(name)) return unavailable;
    seen.add(name);
    result.push({
      name,
      size,
      downloadUrl: R2_ORIGIN + "/" + release.tag + "/" + encodeURIComponent(name),
    });
  }
  return { available: true, tag: release.tag, assets: result };
}

export async function fetchVerifiedR2Mirror(
  release: GithubMirrorRelease,
  request: typeof fetch = fetch,
): Promise<VerifiedMirrorResult> {
  const unavailable: VerifiedMirrorResult = { available: false, tag: release.tag };
  if (!TAG_PATTERN.test(release.tag) || release.draft || release.prerelease) return unavailable;
  try {
    const response = await request(R2_ORIGIN + "/" + release.tag + "/manifest.json", {
      signal: AbortSignal.timeout(5000),
      headers: { Accept: "application/json, application/octet-stream" },
    });
    if (!response.ok) return unavailable;
    if (response.url && new URL(response.url).origin !== R2_ORIGIN) return unavailable;
    const text = await response.text();
    if (text.length > 32768) return unavailable;
    return validateMirrorManifest(release, JSON.parse(text));
  } catch {
    return unavailable;
  }
}
