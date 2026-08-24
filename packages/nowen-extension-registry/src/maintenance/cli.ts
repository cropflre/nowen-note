import path from "node:path";
import { loadRegistryConfig } from "../config.js";
import { openRegistry } from "../schema.js";
import { LocalArtifactStore } from "../storage/localArtifactStore.js";
import { S3ArtifactStore } from "../storage/s3ArtifactStore.js";
import { collectArtifactGarbage } from "./artifactGc.js";
import { createRegistryBackup, restoreRegistryBackup, verifyRegistryBackup } from "./backup.js";

function argsMap(argv: string[]): Map<string, string | true> {
  const result = new Map<string, string | true>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith("--")) continue;
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      result.set(token.slice(2), next);
      index += 1;
    } else result.set(token.slice(2), true);
  }
  return result;
}

function stringArg(args: Map<string, string | true>, name: string, fallback?: string): string {
  const value = args.get(name);
  if (typeof value === "string" && value.trim()) return value.trim();
  if (fallback !== undefined) return fallback;
  throw new Error(`--${name} is required`);
}

function numberArg(args: Map<string, string | true>, name: string, fallback: number): number {
  const raw = args.get(name);
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isFinite(value)) throw new Error(`--${name} must be a number`);
  return value;
}

function defaultDataRoot(): string {
  return path.resolve(process.env.REGISTRY_DATA?.trim() || "data");
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function usage(): never {
  throw new Error(`Usage:
  npm run maintenance -- backup [--data-root data] [--output backups]
  npm run maintenance -- verify --database backup.sqlite --manifest backup.manifest.json
  npm run maintenance -- restore --database backup.sqlite --manifest backup.manifest.json [--data-root data] [--apply]
  npm run maintenance -- gc [--grace-hours 24] [--max-delete 1000] [--apply]

restore --apply requires the Registry process to be stopped. Artifact GC is dry-run unless --apply is supplied.`);
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (!command) usage();
  const args = argsMap(rest);

  if (command === "backup") {
    const dataRoot = path.resolve(stringArg(args, "data-root", defaultDataRoot()));
    const output = path.resolve(stringArg(args, "output", path.join(dataRoot, "backups")));
    print(await createRegistryBackup({ sourceDbPath: path.join(dataRoot, "registry.db"), outputDirectory: output }));
    return;
  }

  if (command === "verify") {
    const database = path.resolve(stringArg(args, "database"));
    const manifest = path.resolve(stringArg(args, "manifest"));
    const result = await verifyRegistryBackup(database, manifest);
    print(result);
    if (!result.ok) process.exitCode = 2;
    return;
  }

  if (command === "restore") {
    const dataRoot = path.resolve(stringArg(args, "data-root", defaultDataRoot()));
    const result = await restoreRegistryBackup({
      databasePath: path.resolve(stringArg(args, "database")),
      manifestPath: path.resolve(stringArg(args, "manifest")),
      targetDbPath: path.join(dataRoot, "registry.db"),
      apply: args.get("apply") === true,
    });
    print(result);
    return;
  }

  if (command === "gc") {
    const graceHours = numberArg(args, "grace-hours", 24);
    if (!Number.isFinite(graceHours) || graceHours < 1 || graceHours > 24 * 365) throw new Error("--grace-hours must be between 1 and 8760");
    const maxDeletes = numberArg(args, "max-delete", 1_000);
    if (!Number.isSafeInteger(maxDeletes) || maxDeletes <= 0 || maxDeletes > 100_000) throw new Error("--max-delete must be between 1 and 100000");
    const config = loadRegistryConfig();
    const artifactStore = config.artifactStorage.driver === "local"
      ? new LocalArtifactStore(config.artifactStorage.root)
      : new S3ArtifactStore(config.artifactStorage);
    const db = openRegistry(path.join(config.dataRoot, "registry.db"));
    try {
      print(await collectArtifactGarbage({
        db,
        artifactStore,
        graceMs: Math.round(graceHours * 60 * 60 * 1_000),
        maxDeletes,
        apply: args.get("apply") === true,
      }));
    } finally {
      db.close();
    }
    return;
  }

  usage();
}

main().catch((error) => {
  process.stderr.write(`[registry-maintenance] ${(error as Error).message}\n`);
  process.exitCode = 1;
});
