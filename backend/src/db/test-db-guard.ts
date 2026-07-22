import os from "node:os";
import path from "node:path";

export function assertSafeTestDatabasePath(dbPath: string): void {
  if (process.env.NODE_ENV !== "test") return;

  const resolvedPath = path.resolve(dbPath);
  const temporaryRoot = path.resolve(os.tmpdir());
  const relative = path.relative(temporaryRoot, resolvedPath);
  const isInsideTemporaryRoot = relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
  if (!isInsideTemporaryRoot) {
    throw new Error(
      `[test-db-isolation] Refusing to open a test database outside the system temporary directory: ${resolvedPath}`,
    );
  }
}
