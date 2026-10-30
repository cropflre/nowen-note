import assert from "node:assert/strict";
import test from "node:test";
import { waitForImageHost, deferImageHost } from "../src/services/remote-image-localization-throttle";

test("same-host requests across jobs are spaced, while other hosts remain independent", async (t) => {
  let now = 0;
  t.mock.method(Date, "now", () => now);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const started: number[] = [];
  const first = waitForImageHost("spacing.example", () => false).then(() => started.push(now));
  const second = waitForImageHost("spacing.example", () => false).then(() => started.push(now));
  await first;
  await waitForImageHost("independent.example", () => false);
  assert.deepEqual(started, [0]);
  for (let i = 0; i < 8; i += 1) { now += 250; t.mock.timers.tick(250); await Promise.resolve(); }
  await second;
  assert.deepEqual(started, [0, 2000]);
});

test("rate limits extend the host cooldown and waiting can be stopped promptly", async (t) => {
  let now = 100_000;
  let stopped = false;
  t.mock.method(Date, "now", () => now);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  deferImageHost("limited.example", 60_000);
  const waiting = waitForImageHost("limited.example", () => stopped);
  now += 59_750; t.mock.timers.tick(59_750); await Promise.resolve();
  stopped = true;
  const rejected = assert.rejects(waiting, /stopped/);
  now += 250; t.mock.timers.tick(250);
  await rejected;
  // A second rate limit backs off further rather than immediately sending again.
  deferImageHost("limited.example");
  let ready = false;
  const next = waitForImageHost("limited.example", () => false).then(() => { ready = true; });
  now += 59_750; t.mock.timers.tick(59_750); await Promise.resolve();
  assert.equal(ready, false);
  now += 250; t.mock.timers.tick(250);
  await next;
  assert.equal(ready, true);
});
