import { describe, expect, it } from "vitest";
import {
  buildExtensionListings,
  FEATURED_EXTENSIONS,
  filterExtensionListings,
  mapExtensionCategory,
  nowenRangeSatisfies,
  permissionRisk,
  pickFeaturedListings,
  pickInstallCandidate,
  sortPermissionsByRisk,
  uiPlatformSupported,
  type BuildCatalogInput,
  type CatalogSourceResult,
} from "../extensionCatalog";
import type { InstalledPlugin, RegistryIndexExtension, RegistrySource } from "../pluginApi";

const official: RegistrySource = { id: "official-v2", name: "Nowen Official Registry", indexUrl: "https://example.invalid/v2/index.json", official: true, enabled: true, registryKeyId: null, registryPublicKey: null };
const custom: RegistrySource = { id: "mirror", name: "Mirror", indexUrl: "https://mirror.invalid/v2/index.json", official: false, enabled: true, registryKeyId: "k", registryPublicKey: "p" };

function extension(id: string, overrides: Partial<RegistryIndexExtension> = {}): RegistryIndexExtension {
  return {
    id, publisher: id.split(".")[0], name: `Name ${id}`, description: `Description ${id}`, trustLevel: "community", category: "productivity",
    versions: [{ version: "1.0.0", runtime: "sandbox-js", nowen: ">=1.5.0 <2.0.0", permissions: ["notes:read"] }],
    ...overrides,
  };
}

function installed(id: string, overrides: Partial<InstalledPlugin> = {}): InstalledPlugin {
  return {
    id, name: `Installed ${id}`, description: "installed", version: "1.0.0", runtime: "sandbox-js", source: "registry", trustLevel: "community",
    status: "enabled", checksum: "x", actions: [], permissions: [{ permission: "notes:read", configJson: "{}", granted: 1 }],
    ...overrides,
  };
}

function input(sources: CatalogSourceResult[], overrides: Partial<BuildCatalogInput> = {}): BuildCatalogInput {
  return {
    sources, installed: [], isAdmin: true, nowenVersion: "1.5.3", runtimePlatform: "server", uiPlatform: "web",
    nodeRuntimeAllowed: false, dashboardAvailable: true,
    builtinText: (id) => ({ name: `builtin ${id}`, description: `builtin description ${id}` }),
    ...overrides,
  };
}

describe("extension catalog categories and versions", () => {
  it("maps registry and manifest categories onto the center tabs", () => {
    expect(mapExtensionCategory(["editor"])).toBe("editor");
    expect(mapExtensionCategory(["capture"])).toBe("import");
    expect(mapExtensionCategory([undefined, "", "Themes"])).toBe("appearance");
    expect(mapExtensionCategory(["写作"])).toBe("editor");
    expect(mapExtensionCategory(["development"])).toBe("other");
    expect(mapExtensionCategory([])).toBe("other");
  });

  it("evaluates Nowen ranges with the same operators as the server", () => {
    const cases: Array<[string | undefined, string, boolean]> = [
      [">=1.5.0 <2.0.0", "1.5.3", true],
      [">=1.6.0", "1.5.3", false],
      [">1.5.3", "1.5.3", false],
      ["<=1.5.3", "1.5.3", true],
      ["^1.5.0", "1.9.0", true],
      ["^2.0.0", "1.9.0", false],
      ["~1.5.0", "1.5.9", true],
      ["~1.4.0", "1.5.0", false],
      ["1.5.3", "1.5.3", true],
      ["=1.5.2", "1.5.3", false],
      ["", "1.5.3", false],
      [undefined, "1.5.3", false],
      ["latest", "1.5.3", false],
    ];
    for (const [range, current, expected] of cases) expect(nowenRangeSatisfies(range, current), `${range} @ ${current}`).toBe(expected);
  });

  it("picks the newest version this server can install", () => {
    const versions = [
      { version: "1.0.0", nowen: ">=1.5.0" },
      { version: "1.10.0", nowen: ">=1.6.0" },
      { version: "1.2.0", nowen: ">=1.5.0", runtimePlatform: ["server"] },
    ];
    expect(pickInstallCandidate(versions, { nowenVersion: "1.5.3", runtimePlatform: "server" })).toMatchObject({ latest: { version: "1.10.0" }, candidate: { version: "1.2.0" } });
    expect(pickInstallCandidate([{ version: "1.0.0", nowen: ">=1.5.0", runtimePlatform: ["desktop-full"] }], { nowenVersion: "1.5.3", runtimePlatform: "server" }).incompatibleReason).toBe("RUNTIME_PLATFORM");
    expect(pickInstallCandidate([{ version: "2.0.0", nowen: ">=1.6.0" }], { nowenVersion: "1.5.3" }).incompatibleReason).toBe("NOWEN_VERSION");
    expect(pickInstallCandidate([], { nowenVersion: "1.5.3" }).incompatibleReason).toBe("NO_VERSIONS");
  });

  it("treats undeclared UI platforms as unknown and maps the registry mobile alias", () => {
    expect(uiPlatformSupported(undefined, "web")).toBeUndefined();
    expect(uiPlatformSupported(["web", "desktop", "mobile"], "android")).toBe(true);
    expect(uiPlatformSupported(["desktop"], "web")).toBe(false);
  });

  it("orders permissions from secrets and network to writes and reads", () => {
    expect(permissionRisk("secrets:use")).toBe("secrets");
    expect(permissionRisk("external:fetch")).toBe("network");
    expect(permissionRisk("capture:write")).toBe("write");
    expect(permissionRisk("tasks:read")).toBe("read");
    expect(sortPermissionsByRisk(["notes:read", "external:fetch", "notes:write", "secrets:use", "notes:read"]))
      .toEqual(["secrets:use", "external:fetch", "notes:write", "notes:read"]);
  });
});

describe("extension listings", () => {
  it("only labels official-root sources as official and merges duplicate listings", () => {
    const listings = buildExtensionListings(input([
      { source: custom, index: { extensions: [extension("acme.both", { trustLevel: "official" }), extension("acme.spoof", { trustLevel: "official" })] } },
      { source: official, index: { extensions: [extension("acme.both", { trustLevel: "official" })] } },
    ]));
    const both = listings.find((item) => item.id === "acme.both")!;
    expect(both.official).toBe(true);
    expect(both.sources.map((item) => item.sourceId)).toEqual(["official-v2", "mirror"]);
    expect(listings.find((item) => item.id === "acme.spoof")!.official).toBe(false);
  });

  it("derives primary actions from server state, role, compatibility and runtime policy", () => {
    const sources: CatalogSourceResult[] = [{ source: official, index: { extensions: [
      extension("acme.free"),
      extension("acme.node", { versions: [{ version: "1.0.0", runtime: "node-action", nowen: ">=1.5.0", permissions: [] }] }),
      extension("acme.future", { versions: [{ version: "3.0.0", nowen: ">=3.0.0" }] }),
      extension("acme.pending"),
      extension("acme.enabled", { versions: [{ version: "1.0.0", nowen: ">=1.5.0" }, { version: "1.2.0", nowen: ">=1.5.0", permissions: ["notes:read", "notes:write"] }] }),
    ] } }];
    const installedRecords = [
      installed("acme.pending", { status: "quarantined", permissions: [{ permission: "notes:read", configJson: "{}", granted: 0 }] }),
      installed("acme.enabled"),
    ];
    const admin = new Map(buildExtensionListings(input(sources, { installed: installedRecords })).map((item) => [item.id, item]));
    expect(admin.get("acme.free")).toMatchObject({ installState: "not-installed", primaryAction: "install", permissions: ["notes:read"] });
    expect(admin.get("acme.node")).toMatchObject({ primaryAction: "unavailable", unavailableReason: "NODE_POLICY" });
    expect(admin.get("acme.future")).toMatchObject({ primaryAction: "unavailable", unavailableReason: "NOWEN_VERSION", latestVersion: "3.0.0" });
    expect(admin.get("acme.pending")).toMatchObject({ installState: "pending", primaryAction: "review-enable", ungrantedPermissions: ["notes:read"] });
    expect(admin.get("acme.enabled")).toMatchObject({ installState: "enabled", primaryAction: "manage", updateVersion: "1.2.0" });

    const member = new Map(buildExtensionListings(input(sources, { installed: installedRecords, isAdmin: false, nodeRuntimeAllowed: null })).map((item) => [item.id, item]));
    expect(member.get("acme.free")!.primaryAction).toBe("needs-admin");
    expect(member.get("acme.pending")!.primaryAction).toBe("needs-admin");
    expect(member.get("acme.enabled")!.primaryAction).toBe("manage");

    const allowed = buildExtensionListings(input(sources, { nodeRuntimeAllowed: true })).find((item) => item.id === "acme.node")!;
    expect(allowed.primaryAction).toBe("install");
  });

  it("keeps package-installed plugins and built-in features, never inventing install state", () => {
    const listings = buildExtensionListings(input([{ source: official, error: { message: "offline" } }], {
      installed: [installed("acme.uploaded", { source: "package", apiVersion: 3, category: "dashboard", status: "disabled" })],
      dashboardAvailable: false,
    }));
    const uploaded = listings.find((item) => item.id === "acme.uploaded")!;
    expect(uploaded).toMatchObject({ sources: [], installState: "disabled", primaryAction: "review-enable", category: "workbench" });
    const builtins = listings.filter((item) => item.kind === "builtin").map((item) => item.id);
    expect(builtins).not.toContain("dashboard");
    expect(builtins).toEqual(expect.arrayContaining(["studio", "tasks", "diary", "mindmaps", "ai-chat"]));
    expect(listings.filter((item) => item.kind === "builtin").every((item) => item.installState === "builtin" && item.primaryAction === "open")).toBe(true);
  });

  it("flags active advisories but ignores withdrawn ones", () => {
    const listings = buildExtensionListings(input([{ source: official, index: {
      extensions: [extension("acme.bad"), extension("acme.fixed")],
      advisories: [{ pluginId: "acme.bad", state: "active" }, { pluginId: "acme.fixed", state: "withdrawn" }],
    } }]));
    expect(listings.find((item) => item.id === "acme.bad")!.hasAdvisory).toBe(true);
    expect(listings.find((item) => item.id === "acme.fixed")!.hasAdvisory).toBe(false);
  });

  it("filters by category, installed state and AND-ed search tokens", () => {
    const listings = buildExtensionListings(input([{ source: official, index: { extensions: [
      extension("acme.writer", { name: "Writer", category: "editor", keywords: ["markdown"] }),
      extension("acme.capture", { name: "Capture", category: "capture" }),
    ] } }], { installed: [installed("acme.capture")] }));
    expect(filterExtensionListings(listings, { category: "editor" }).map((item) => item.id)).toEqual(["acme.writer"]);
    expect(filterExtensionListings(listings, { installedOnly: true }).map((item) => item.id)).toEqual(["acme.capture"]);
    expect(filterExtensionListings(listings, { query: "WRITER markdown" }).map((item) => item.id)).toEqual(["acme.writer"]);
    expect(filterExtensionListings(listings, { query: "writer capture" })).toEqual([]);
    expect(filterExtensionListings(listings, { query: "数据导入" }, (category) => (category === "import" ? "数据导入" : category)).map((item) => item.id)).toEqual(["acme.capture"]);
  });

  it("keeps editorial picks auditable and shows only listings that exist", () => {
    for (const item of FEATURED_EXTENSIONS) expect(Object.keys(item).sort()).toEqual(["key", "reasonKey"]);
    expect(new Set(FEATURED_EXTENSIONS.map((item) => item.key)).size).toBe(FEATURED_EXTENSIONS.length);
    const listings = buildExtensionListings(input([{ source: official, index: { extensions: [] } }], { dashboardAvailable: false }));
    expect(pickFeaturedListings(listings).map((item) => item.listing.key)).toEqual(["builtin:studio"]);
  });
});
