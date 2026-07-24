import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

function schemaCandidates(): string[] {
  return [
    join(__dirname, "schema.sql"),
    join(__dirname, "postgres", "schema.sql"),
    join(process.cwd(), "src", "db", "postgres", "schema.sql"),
    join(process.cwd(), "backend", "src", "db", "postgres", "schema.sql"),
    join(process.cwd(), "dist", "postgres", "schema.sql"),
  ];
}

export function resolvePostgresSchemaPath(): string {
  const schemaPath = schemaCandidates().find((candidate) => existsSync(candidate));
  if (!schemaPath) {
    throw new Error("[db] PostgreSQL schema.sql not found in source or production bundle");
  }
  return resolve(schemaPath);
}

function inlinePsqlIncludes(source: string, sourcePath: string, seen: Set<string>): string {
  return source.replace(/^\\ir\s+(.+)$/gm, (_line, relativePath: string) => {
    const clean = relativePath.trim().replace(/^['"]|['"]$/g, "");
    const includePath = isAbsolute(clean) ? clean : join(dirname(sourcePath), clean);
    const resolvedPath = resolve(includePath);
    if (seen.has(resolvedPath)) {
      throw new Error(`[db] cyclic PostgreSQL schema include: ${resolvedPath}`);
    }
    if (!existsSync(resolvedPath)) {
      throw new Error(`[db] PostgreSQL schema include not found: ${resolvedPath}`);
    }
    seen.add(resolvedPath);
    const included = readFileSync(resolvedPath, "utf-8");
    return inlinePsqlIncludes(included, resolvedPath, seen);
  });
}

/**
 * 读取 PostgreSQL schema，并展开 psql 的 \ir 指令。
 * node-postgres 不理解 psql meta command，因此运行时和测试必须共用此加载器。
 */
export function readPostgresSchemaSource(schemaPath = resolvePostgresSchemaPath()): string {
  const resolvedPath = resolve(schemaPath);
  const source = readFileSync(resolvedPath, "utf-8").replace(/^\\set.*$/gm, "");
  return inlinePsqlIncludes(source, resolvedPath, new Set([resolvedPath]));
}
