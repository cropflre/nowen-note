import { getDb } from "../db/schema";
import type { DatabaseAdapter } from "../db/adapters/types";
import { nowExpression } from "../db/dialect";
import { getDatabaseAdapter, getDatabaseDialect } from "../db/runtime";
import type { CustomFont } from "./types";

function resolveAdapter(adapter?: DatabaseAdapter): DatabaseAdapter {
  return adapter ?? getDatabaseAdapter();
}

function resolveNowExpr(nowExpr?: string): string {
  if (nowExpr) return nowExpr;
  try {
    return nowExpression(getDatabaseDialect());
  } catch {
    return nowExpression("sqlite");
  }
}

/**
 * 创建 customFontsRepository 实例。
 *
 * 未显式注入 adapter 时，异步方法从统一数据库运行时获取 Adapter；
 * 同步方法继续仅支持 SQLite，以保持现有调用兼容。
 */
export function createCustomFontsRepository(
  adapter?: DatabaseAdapter,
  nowExpr?: string,
) {
  const getAdapter = () => resolveAdapter(adapter);
  const getNowExpr = () => resolveNowExpr(nowExpr);

  return {
    // ---- 同步方法（仅 SQLite） ----

    getAll(): CustomFont[] {
      const db = getDb();
      return db
        .prepare(
          'SELECT id, name, "fileName", format, "fileSize", "createdAt" FROM custom_fonts ORDER BY "createdAt" DESC',
        )
        .all() as CustomFont[];
    },

    getList(): Array<Omit<CustomFont, "fileSize">> {
      const db = getDb();
      return db
        .prepare(
          'SELECT id, name, "fileName", format, "createdAt" FROM custom_fonts ORDER BY "createdAt" DESC',
        )
        .all() as Array<Omit<CustomFont, "fileSize">>;
    },

    getById(id: string): CustomFont | undefined {
      const db = getDb();
      return db
        .prepare(
          'SELECT id, name, "fileName", format, "fileSize", "createdAt" FROM custom_fonts WHERE id = ?',
        )
        .get(id) as CustomFont | undefined;
    },

    getByIdForDownload(
      id: string,
    ): Pick<CustomFont, "id" | "fileName" | "format"> | undefined {
      const db = getDb();
      return db
        .prepare('SELECT id, "fileName", format FROM custom_fonts WHERE id = ?')
        .get(id) as Pick<CustomFont, "id" | "fileName" | "format"> | undefined;
    },

    getByFileName(fileName: string): CustomFont | undefined {
      const db = getDb();
      return db
        .prepare(
          'SELECT id, name, "fileName", format, "fileSize", "createdAt" FROM custom_fonts WHERE "fileName" = ?',
        )
        .get(fileName) as CustomFont | undefined;
    },

    getIdByFileName(fileName: string): string | undefined {
      const db = getDb();
      const row = db
        .prepare('SELECT id FROM custom_fonts WHERE "fileName" = ?')
        .get(fileName) as { id: string } | undefined;
      return row?.id;
    },

    create(
      font: Omit<CustomFont, "createdAt"> & { createdAt?: string },
    ): void {
      const db = getDb();
      db.prepare(
        `INSERT INTO custom_fonts (id, name, "fileName", format, "fileSize", "createdAt")
         VALUES (?, ?, ?, ?, ?, ${getNowExpr()})`,
      ).run(font.id, font.name, font.fileName, font.format, font.fileSize);
    },

    delete(id: string): void {
      const db = getDb();
      db.prepare("DELETE FROM custom_fonts WHERE id = ?").run(id);
    },

    existsByFileName(fileName: string): boolean {
      const db = getDb();
      const result = db
        .prepare('SELECT 1 FROM custom_fonts WHERE "fileName" = ? LIMIT 1')
        .get(fileName);
      return !!result;
    },

    // ---- Async 方法（支持运行时 Adapter / 显式注入） ----

    async getAllAsync(): Promise<CustomFont[]> {
      return getAdapter().queryMany<CustomFont>(
        'SELECT id, name, "fileName", format, "fileSize", "createdAt" FROM custom_fonts ORDER BY "createdAt" DESC',
      );
    },

    async getListAsync(): Promise<Array<Omit<CustomFont, "fileSize">>> {
      return getAdapter().queryMany<Omit<CustomFont, "fileSize">>(
        'SELECT id, name, "fileName", format, "createdAt" FROM custom_fonts ORDER BY "createdAt" DESC',
      );
    },

    async getByIdAsync(id: string): Promise<CustomFont | undefined> {
      return getAdapter().queryOne<CustomFont>(
        'SELECT id, name, "fileName", format, "fileSize", "createdAt" FROM custom_fonts WHERE id = ?',
        [id],
      );
    },

    async getByIdForDownloadAsync(
      id: string,
    ): Promise<Pick<CustomFont, "id" | "fileName" | "format"> | undefined> {
      return getAdapter().queryOne<Pick<CustomFont, "id" | "fileName" | "format">>(
        'SELECT id, "fileName", format FROM custom_fonts WHERE id = ?',
        [id],
      );
    },

    async getByFileNameAsync(fileName: string): Promise<CustomFont | undefined> {
      return getAdapter().queryOne<CustomFont>(
        'SELECT id, name, "fileName", format, "fileSize", "createdAt" FROM custom_fonts WHERE "fileName" = ?',
        [fileName],
      );
    },

    async getIdByFileNameAsync(fileName: string): Promise<string | undefined> {
      const row = await getAdapter().queryOne<{ id: string }>(
        'SELECT id FROM custom_fonts WHERE "fileName" = ?',
        [fileName],
      );
      return row?.id;
    },

    async createAsync(
      font: Omit<CustomFont, "createdAt"> & { createdAt?: string },
    ): Promise<void> {
      await getAdapter().execute(
        `INSERT INTO custom_fonts (id, name, "fileName", format, "fileSize", "createdAt")
         VALUES (?, ?, ?, ?, ?, ${getNowExpr()})`,
        [font.id, font.name, font.fileName, font.format, font.fileSize],
      );
    },

    async deleteAsync(id: string): Promise<void> {
      await getAdapter().execute(
        "DELETE FROM custom_fonts WHERE id = ?",
        [id],
      );
    },

    async existsByFileNameAsync(fileName: string): Promise<boolean> {
      const result = await getAdapter().queryOne<{ id: string }>(
        'SELECT 1 FROM custom_fonts WHERE "fileName" = ? LIMIT 1',
        [fileName],
      );
      return !!result;
    },
  };
}

/** 默认实例：同步方法仍为 SQLite；异步方法使用统一运行时 Adapter。 */
export const customFontsRepository = createCustomFontsRepository();
