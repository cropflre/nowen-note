import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import postcss, { type AcceptedPlugin } from "postcss";
import { describe, expect, it } from "vitest";

const requireFromHere = createRequire(import.meta.url);
const frontendRoot = process.cwd();
const dvhFallback = requireFromHere(path.join(frontendRoot, "postcss-dvh-fallback.cjs")) as AcceptedPlugin;

async function run(css: string, plugins: AcceptedPlugin[] = [dvhFallback]): Promise<string> {
  return (await postcss(plugins).process(css, { from: undefined })).css;
}

describe("旧 WebView 的 dvh 回退（PostCSS）", () => {
  it("在每条 dvh 声明前补同名 vh 声明，保留表达式与 !important", async () => {
    expect(await run(".a{max-height:85dvh}")).toBe(".a{max-height:85vh;max-height:85dvh}");
    expect(await run(".b{max-height:calc(100dvh - 3rem)}"))
      .toBe(".b{max-height:calc(100vh - 3rem);max-height:calc(100dvh - 3rem)}");
    expect(await run(".c{height:min(640px,90dvh)}")).toBe(".c{height:min(640px,90vh);height:min(640px,90dvh)}");
    expect(await run(".d{max-height:min(80dvh,600px) !important}"))
      .toBe(".d{max-height:min(80vh,600px) !important;max-height:min(80dvh,600px) !important}");
  });

  it("重复处理不会叠加回退", async () => {
    const once = await run(".a{max-height:85dvh}.b{height:calc(100dvh - 1rem)}");
    expect(await run(once)).toBe(once);
  });

  it("不改选择器、@supports/@media 条件和自定义属性", async () => {
    const css = "@supports not (height: 100dvh){.h-\\[100dvh\\]{height:100vh!important}}"
      + ".e{--panel:100dvh}@media (min-height:50dvh){.f{color:red}}";
    expect(await run(css)).toBe(css);
  });

  it("PostCSS 配置在 Tailwind 之后挂载该插件", () => {
    const config = requireFromHere(path.join(frontendRoot, "postcss.config.cjs")) as { plugins: Record<string, unknown> };
    const names = Object.keys(config.plugins);
    expect(names.at(-1)).toBe("./postcss-dvh-fallback.cjs");
    expect(names.indexOf("tailwindcss")).toBeLessThan(names.length - 1);
  });

  it("Tailwind 生成的任意值类（弹窗常用的 max-h-[85dvh] 等）都带 vh 回退", async () => {
    const tailwindcss = requireFromHere("tailwindcss") as (config: object) => AcceptedPlugin;
    const css = await run("@tailwind utilities;", [
      tailwindcss({ content: [{ raw: '<div class="max-h-[85dvh] h-[80dvh] max-h-[calc(100dvh-3rem)] min-h-[100dvh]"></div>' }] }),
      dvhFallback,
    ]);
    const root = postcss.parse(css);
    let checked = 0;
    root.walkDecls((decl) => {
      if (!decl.value.includes("dvh")) return;
      checked += 1;
      const previous = decl.prev();
      expect(previous?.type === "decl" ? `${previous.prop}:${previous.value}` : null)
        .toBe(`${decl.prop}:${decl.value.replace(/dvh/g, "vh")}`);
    });
    expect(checked).toBe(4);
  });

  it("index.html 的内联 <style> 不经过 PostCSS，其中的 dvh 声明已手工补好回退", async () => {
    const html = readFileSync(path.join(frontendRoot, "index.html"), "utf8");
    const styles = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((match) => match[1]);
    expect(styles.join("")).toContain("dvh");
    for (const css of styles) expect(await run(css)).toBe(css);
  });
});
