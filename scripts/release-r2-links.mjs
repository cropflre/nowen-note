import fs from "node:fs";

const MIRROR_ORIGIN = "https://download.nowen.cn";

function releaseTag(tag) {
  return /^v\d+\.\d+\.\d+$/.test(tag ?? "");
}

function approvedMirrorName(name, tag) {
  const version = tag.slice(1);
  const names = new Set([
    "Nowen-Note-" + version + "-setup.exe",
    "Nowen-Note-" + version + "-arm64.dmg",
    "Nowen-Note-" + version + "-x64.dmg",
    "Nowen-Note-" + version + "-x86_64.AppImage",
    "Nowen-Note-" + version + "-amd64.deb",
    "Nowen-Note-" + version + ".apk",
    "nowen-note-" + version + "-fpk-r1.fpk",
    "nowen-note-" + version + ".fpk"
  ]);
  return names.has(name) ||
    /^nowen-clipper-\d+\.\d+\.\d+(?:-(?:edge|firefox))?\.zip$/.test(name);
}

export function trustedMirrorNames(release, manifest) {
  const tag = release?.tag_name;
  const result = new Set();
  if (!releaseTag(tag) || release?.draft || release?.prerelease ||
      manifest?.schema !== 1 || manifest.version !== tag ||
      !Array.isArray(manifest.assets) || manifest.assets.length !== 10) return result;
  const github = new Map((release.assets ?? []).map(a => [a.name, a]));
  for (const item of manifest.assets) {
    if (!item || typeof item.name !== "string" || !Number.isSafeInteger(item.size) ||
        !approvedMirrorName(item.name, tag) || result.has(item.name) ||
        !github.has(item.name) || github.get(item.name).size !== item.size) {
      return new Set();
    }
    result.add(item.name);
  }
  return result;
}

export function releaseDownloadLinks(release, mirror) {
  const tag = release?.tag_name;
  if (!releaseTag(tag)) throw new Error("Invalid release tag");
  const approved = trustedMirrorNames(release, mirror);
  const downloads = (release.assets ?? [])
    .filter(asset => /^[A-Za-z0-9._-]+$/.test(asset.name || "") &&
      /\.(exe|msi|dmg|zip|AppImage|deb|rpm|apk|aab|fpk|upk|tar|gz)$/i.test(asset.name) &&
      Number.isSafeInteger(asset.size) && asset.size > 0 &&
      asset.browser_download_url ===
        "https://github.com/cropflre/nowen-note/releases/download/" +
        tag + "/" + encodeURIComponent(asset.name))
    .sort((a, b) => a.name.localeCompare(b.name));

  return downloads.map(a => {
    const github = a.browser_download_url;
    const isMirror = approved.has(a.name);
    const primary = isMirror
      ? MIRROR_ORIGIN + "/" + tag + "/" + encodeURIComponent(a.name)
      : github;
    const mib = Math.round(a.size / 1048576 * 10) / 10;
    const backup = isMirror ? " · [GitHub 原站备用](" + github + ")" : "";
    return "- [" + a.name + "](" + primary + ") (" + mib + " MiB)" +
      (isMirror ? " · R2 下载源" : " · GitHub 原站") + backup;
  }).join("\n");
}

if (process.argv[1] && import.meta.url === new URL("file://" + process.argv[1]).href) {
  const [releasePath, manifestPath] = process.argv.slice(2);
  if (!releasePath || !manifestPath) {
    console.error("Usage: node release-r2-links.mjs GH_RELEASE_JSON R2_MANIFEST_JSON");
    process.exit(2);
  }
  const release = JSON.parse(fs.readFileSync(releasePath, "utf8"));
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  process.stdout.write(releaseDownloadLinks(release, manifest));
}
