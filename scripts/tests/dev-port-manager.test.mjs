import assert from "node:assert/strict"
import net from "node:net"
import process from "node:process"
import test from "node:test"
import { spawn } from "node:child_process"
import { EventEmitter } from "node:events"
import { forceReleasePort, forceReleasePorts, isPortAvailable } from "../dev-port-manager.mjs"

function mockPortBindings(t, errorForPort) {
  const attemptedPorts = []
  t.mock.method(net, "createServer", () => {
    const server = new EventEmitter()
    server.unref = () => {}
    server.close = (callback) => callback()
    server.listen = ({ port }, callback) => {
      attemptedPorts.push(port)
      const code = errorForPort(port)
      if (code) queueMicrotask(() => server.emit("error", Object.assign(new Error(code), { code })))
      else queueMicrotask(callback)
    }
    return server
  })
  return attemptedPorts
}

test("reserved frontend port falls back past excluded and occupied ports without killing listeners", async (t) => {
  const attemptedPorts = mockPortBindings(t, (port) => {
    if (port >= 5141 && port <= 5240) return "EACCES"
    if (port === 5241) return "EADDRINUSE"
  })
  const logs = []
  const results = await forceReleasePorts([
    { port: 5242, label: "后端" },
    { port: 5173, label: "前端", allowFallback: true },
  ], { log: (message) => logs.push(message) })

  assert.deepEqual(results, [{ port: 5242, killedPids: [] }, { port: 5243, killedPids: [] }])
  assert.equal(attemptedPorts.filter((port) => port === 5242).length, 1)
  assert.match(logs[0], /5173.*EACCES.*5243/)
})

test("explicitly configured reserved port fails with an accurate diagnostic", async (t) => {
  const attemptedPorts = mockPortBindings(t, () => "EACCES")
  await assert.rejects(forceReleasePort(5173, "前端"), (error) => {
    assert.match(error.message, /EACCES.*系统保留/)
    assert.match(error.message, /NOWEN_DEV_FRONTEND_PORT/)
    assert.doesNotMatch(error.message, /已被占用|管理员/)
    return true
  })
  assert.deepEqual(attemptedPorts, [5173])
})

test("unrelated bind failures retain their original error code", async (t) => {
  mockPortBindings(t, () => "EMFILE")
  await assert.rejects(forceReleasePort(5173, "前端", { allowFallback: true }), { code: "EMFILE" })
})

test("fallback fails clearly when no higher port is available", async (t) => {
  mockPortBindings(t, () => "EACCES")
  await assert.rejects(forceReleasePort(65535, "前端", { allowFallback: true }), /65535.*EACCES/)
})

function reserveFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once("error", reject)
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      const address = server.address()
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("无法分配测试端口")))
        return
      }
      const port = address.port
      server.close((error) => error ? reject(error) : resolve(port))
    })
  })
}

function waitForReady(child, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    let output = ""
    const timer = setTimeout(() => {
      reject(new Error(`测试监听进程启动超时：${output}`))
    }, timeoutMs)

    const cleanup = () => {
      clearTimeout(timer)
      child.stdout?.off("data", onData)
      child.off("exit", onExit)
      child.off("error", onError)
    }
    const onData = (chunk) => {
      output += String(chunk)
      if (!output.includes("READY")) return
      cleanup()
      resolve()
    }
    const onExit = (code, signal) => {
      cleanup()
      reject(new Error(`测试监听进程提前退出：code=${code} signal=${signal}`))
    }
    const onError = (error) => {
      cleanup()
      reject(error)
    }

    child.stdout?.on("data", onData)
    child.once("exit", onExit)
    child.once("error", onError)
  })
}

function waitForExit(child, timeoutMs = 5_000) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode })
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("占用端口的测试进程未被终止")), timeoutMs)
    child.once("exit", (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal })
    })
  })
}

test("forceReleasePort kills the listening process and releases its port", async () => {
  const port = await reserveFreePort()
  const listenerScript = [
    "const net = require('node:net')",
    `const server = net.createServer().listen(${port}, '0.0.0.0', () => process.stdout.write('READY\\n'))`,
    "const close = () => server.close(() => process.exit(0))",
    "process.on('SIGTERM', close)",
    "process.on('SIGINT', close)",
    "setInterval(() => {}, 1000)",
  ].join(";")

  const child = spawn(process.execPath, ["-e", listenerScript], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  })

  try {
    await waitForReady(child)
    assert.equal(await isPortAvailable(port), false)

    const result = await forceReleasePort(port, "测试", {
      timeoutMs: 5_000,
      log: () => {},
    })

    assert.ok(result.killedPids.includes(child.pid))
    await waitForExit(child)
    assert.equal(await isPortAvailable(port), true)
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL")
      await waitForExit(child).catch(() => {})
    }
  }
})
