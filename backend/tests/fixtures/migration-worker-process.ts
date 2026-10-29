async function main() {
  await import("../../src/runtime/knowledge-tree-migration-bootstrap");
  const service = await import("../../src/services/migrationService");
  const [jobId, mode] = process.argv.slice(2);
  service.recoverMigrations();
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const job = service.getMigration({ userId: "restart-user" }, jobId);
    if (mode === "interrupt" && Number(job.counts.imported) >= 5) process.exit(0);
    if (mode === "complete" && job.status === "COMPLETED") process.exit(0);
    if (["FAILED", "PARTIAL", "CANCELLED"].includes(job.status)) throw new Error(JSON.stringify(job));
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("migration recovery timeout");
}
main().catch((error) => { console.error(error); process.exit(1); });
