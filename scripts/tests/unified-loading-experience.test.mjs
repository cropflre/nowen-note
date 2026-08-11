import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"

const __filename = fileURLToPath(import.meta.url)
const rootDir = path.resolve(path.dirname(__filename), "../..")

async function readRepoFile(relativePath) {
  return readFile(path.join(rootDir, relativePath), "utf8")
}

test("cold start has one delayed branded loading surface", async () => {
  const html = await readRepoFile("frontend/index.html")

  assert.equal((html.match(/id="app-boot-splash"/g) || []).length, 1)
  assert.match(html, /__NOWEN_BOOT_REVEAL_TIMER__\s*=\s*window\.setTimeout/)
  assert.match(html, /},\s*260\);/)
  assert.match(html, /正在恢复你的工作区…/)
  assert.doesNotMatch(html, /正在加载你的笔记/)
})

test("React lazy loading stays visually silent behind the startup splash", async () => {
  const main = await readRepoFile("frontend/src/main.tsx")

  assert.match(main, /observeBootSplashReadiness/)
  assert.match(main, /function MainRouteFallback\(\)\s*{\s*return null;\s*}/)
  assert.doesNotMatch(main, /function BootSplashRemover/)
  assert.doesNotMatch(main, />\s*正在加载…\s*</)
})

test("startup controller hides transient auth UI and is stable in StrictMode", async () => {
  const controller = await readRepoFile("frontend/src/lib/bootSplash.ts")

  assert.match(controller, /BOOT_SPLASH_MIN_VISIBLE_MS\s*=\s*600/)
  assert.match(controller, /concealReactRoot\(\);/)
  assert.match(controller, /root\.style\.opacity\s*=\s*"0"/)
  assert.match(controller, /root\.style\.opacity\s*=\s*"1"/)
  assert.doesNotMatch(controller, /root\.style\.visibility\s*=\s*"hidden"/)
  assert.match(controller, /React\.StrictMode intentionally mounts/)
  const cleanup = controller.slice(controller.lastIndexOf("return () =>"))
  assert.doesNotMatch(cleanup, /clearTimeout/)
  assert.match(cleanup, /observer\.disconnect\(\)/)
})

test("workspace and note loading use structural local feedback", async () => {
  const [css, treePanel, noteSkeleton] = await Promise.all([
    readRepoFile("frontend/src/loading-experience.css"),
    readRepoFile("frontend/src/components/KnowledgeTreePanel.tsx"),
    readRepoFile("frontend/src/components/NoteLoadingSkeleton.tsx"),
  ])

  assert.match(css, /data-nowen-knowledge-tree/)
  assert.match(css, /nowen-tree-skeleton-pulse/)
  assert.match(css, /data-note-loading-state="loading"/)
  assert.match(css, /nowen-note-progress/)
  assert.match(treePanel, /className="flex justify-center py-14"/)
  assert.match(noteSkeleton, /data-note-loading-state=/)
})

test("note switching suppresses fast loading flashes", async () => {
  const coordinator = await readRepoFile("frontend/src/lib/noteLoadCoordinator.ts")

  assert.match(coordinator, /NOTE_LOADING_DELAY_MS\s*=\s*260/)
  assert.match(coordinator, /NOTE_LOADING_MIN_VISIBLE_MS\s*=\s*500/)
  assert.match(coordinator, /NOTE_LOADING_SLOW_MS\s*=\s*1_200/)
})
