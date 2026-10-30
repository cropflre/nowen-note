import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitHub } from "../server/github.ts";
import { redact } from "../server/errors.ts";

test("artifact download uses fixed REST path and never forwards Authorization to signed storage", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "nowen-download-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const calls: any[] = [];
  const github = new GitHub("ghp_secret", (async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    return calls.length === 1
      ? new Response(null, {
          status: 302,
          headers: {
            location:
              "https://archive.blob.core.windows.net/artifact?sig=private",
          },
        })
      : new Response("zip fixture");
  }) as typeof fetch);
  const path = join(directory, "artifact.zip");
  await github.downloadArtifact(123, path, new AbortController().signal, 100);
  assert.match(
    calls[0].url,
    /repos\/cropflre\/nowen-note\/actions\/artifacts\/123\/zip$/,
  );
  assert.equal(calls[0].init.headers.Authorization, "Bearer ghp_secret");
  assert.equal(calls[1].init.headers, undefined);
  assert.equal(calls[1].init.redirect, "error");
  assert.equal(await readFile(path, "utf8"), "zip fixture");
});
test("untrusted download redirects and quota overflow fail closed", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "nowen-download-limit-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const location of [
    "http://archive.blob.core.windows.net/x",
    "https://attacker.invalid/x",
    "https://archive.blob.core.windows.net:444/x",
  ]) {
    const github = new GitHub(
      "",
      (async () =>
        new Response(null, {
          status: 302,
          headers: { location },
        })) as typeof fetch,
    );
    await assert.rejects(
      github.downloadArtifact(
        1,
        join(directory, "unsafe.zip"),
        new AbortController().signal,
        10,
      ),
      /允许范围/,
    );
  }
  for (const declared of [true, false]) {
    let calls = 0;
    const github = new GitHub("", (async () =>
      ++calls === 1
        ? new Response(null, {
            status: 302,
            headers: { location: "https://archive.blob.core.windows.net/x" },
          })
        : new Response("overflow", {
            headers: declared ? { "content-length": "8" } : {},
          })) as typeof fetch);
    await assert.rejects(
      github.downloadArtifact(
        1,
        join(directory, `${declared}.zip`),
        new AbortController().signal,
        4,
      ),
      /下载上限/,
    );
  }
});
test("download cancellation stops a streaming body and signed URLs are redacted", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "nowen-download-cancel-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let started!: () => void;
  const downloading = new Promise<void>((resolve) => {
    started = resolve;
  });
  let calls = 0;
  const github = new GitHub("", (async () => {
    if (++calls === 1)
      return new Response(null, {
        status: 302,
        headers: {
          location: "https://archive.blob.core.windows.net/x?sig=private",
        },
      });
    started();
    return new Response(
      new ReadableStream({
        pull() {
          return new Promise(() => {});
        },
      }),
    );
  }) as typeof fetch);
  const controller = new AbortController();
  const result = github.downloadArtifact(
    1,
    join(directory, "cancel.zip"),
    controller.signal,
    100,
  );
  await downloading;
  controller.abort();
  await assert.rejects(result);
  assert.equal(
    redact("https://archive.blob.core.windows.net/x?sig=private&se=tomorrow"),
    "https://archive.blob.core.windows.net/x?sig=[REDACTED]&se=tomorrow",
  );
});

test("the task deadline stops a stalled storage stream before the archive timeout", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "nowen-download-deadline-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let calls = 0;
  let cancelled = false;
  const github = new GitHub("", (async () => {
    if (++calls === 1)
      return new Response(null, {
        status: 302,
        headers: { location: "https://archive.blob.core.windows.net/x" },
      });
    return new Response(
      new ReadableStream({
        pull() {
          return new Promise(() => {});
        },
        cancel() {
          cancelled = true;
        },
      }),
    );
  }) as typeof fetch);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25);
  t.after(() => clearTimeout(timer));
  await assert.rejects(
    github.downloadArtifact(
      1,
      join(directory, "deadline.zip"),
      controller.signal,
      100,
    ),
    { name: "AbortError" },
  );
  assert.equal(cancelled, true);
});
