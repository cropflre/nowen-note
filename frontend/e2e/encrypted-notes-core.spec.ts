import { expect, test } from "@playwright/test";
import type {} from "../benchmarks/encrypted-notes";

test.beforeEach(async ({ page }) => {
  await page.goto("/benchmarks/encrypted-notes.html");
  await page.waitForFunction(() => Boolean(window.cryptoBenchmark));
});

test("bundled Workers run WASM under CSP and preserve cross-implementation content", async ({ page }, testInfo) => {
  let created = 0;
  let closed = 0;
  const failures: string[] = [];
  page.on("worker", (worker) => { created++; worker.on("close", () => closed++); });
  page.on("pageerror", (error) => failures.push(error.message));
  await page.getByRole("button", { name: "运行核心自检" }).click();
  await expect(page.locator("#result")).toContainText('"status": "passed"');
  await expect.poll(() => closed).toBe(5);
  expect(created).toBe(5);
  expect(failures).toEqual([]);
  const result = await page.locator("#result").textContent();
  await testInfo.attach("desktop-timings.json", { body: result!, contentType: "application/json" });
  const storage = await page.evaluate(async () => ({ local: localStorage.length, session: sessionStorage.length, databases: await indexedDB.databases() }));
  expect(storage).toEqual({ local: 0, session: 0, databases: [] });
});

test("wrong password and altered identity fail without overwriting the envelope", async ({ page }) => {
  const results = await page.evaluate(async () => {
    const { run, vector } = window.cryptoBenchmark;
    const original = JSON.stringify(vector.envelope);
    const codes: string[] = [];
    for (const input of [
      { envelope: vector.envelope, expected: vector.envelope, passphrase: "wrong" },
      { envelope: { ...vector.envelope, kind: "block" }, expected: { ...vector.envelope, kind: "block" as const }, passphrase: vector.passphrase },
    ]) {
      try { await run({ operation: "decrypt", input }); }
      catch (error) { codes.push((error as { code: string }).code); }
    }
    return { codes, unchanged: original === JSON.stringify(vector.envelope) };
  });
  expect(results).toEqual({ codes: ["unlock-failed", "unlock-failed"], unchanged: true });
});

test("cancel terminates a real Worker and the next operation succeeds", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { run, vector } = window.cryptoBenchmark;
    const controller = new AbortController();
    const pending = run({ operation: "decrypt", input: { envelope: vector.envelope, expected: vector.envelope, passphrase: vector.passphrase } }, controller.signal);
    controller.abort();
    let code = "";
    try { await pending; } catch (error) { code = (error as { code: string }).code; }
    const text = await run({ operation: "decrypt", input: { envelope: vector.envelope, expected: vector.envelope, passphrase: vector.passphrase } });
    return { code, matches: text === vector.plaintext };
  });
  expect(result).toEqual({ code: "aborted", matches: true });
});

test("missing Worker fails closed", async ({ page }) => {
  const code = await page.evaluate(async () => {
    const { run, vector } = window.cryptoBenchmark;
    Object.defineProperty(window, "Worker", { value: undefined });
    try { await run({ operation: "decrypt", input: { envelope: vector.envelope, expected: vector.envelope, passphrase: vector.passphrase } }); }
    catch (error) { return (error as { code: string }).code; }
    return "unexpected success";
  });
  expect(code).toBe("unavailable");
});

test("WASM blocked by the worker response CSP fails closed", async ({ page }) => {
  await page.route("**/assets/crypto.worker-*.js", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, headers: { ...response.headers(), "content-security-policy": "default-src 'self'; script-src 'self'" } });
  });
  const code = await page.evaluate(async () => {
    const { run, vector } = window.cryptoBenchmark;
    try { await run({ operation: "decrypt", input: { envelope: vector.envelope, expected: vector.envelope, passphrase: vector.passphrase } }); }
    catch (error) { return (error as { code: string }).code; }
    return "unexpected success";
  });
  expect(code).toBe("unavailable");
});

test("missing Web Crypto fails closed", async ({ page }) => {
  const code = await page.evaluate(async () => {
    const { run, vector } = window.cryptoBenchmark;
    Object.defineProperty(window, "crypto", { value: {} });
    try { await run({ operation: "decrypt", input: { envelope: vector.envelope, expected: vector.envelope, passphrase: vector.passphrase } }); }
    catch (error) { return (error as { code: string }).code; }
    return "unexpected success";
  });
  expect(code).toBe("unavailable");
});
