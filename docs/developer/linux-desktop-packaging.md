# Linux 桌面包图标与桌面入口

Issue [#744](https://github.com/cropflre/nowen-note/issues/744) 反馈 v1.4.16 的 Debian 包在 Linux Mint Cinnamon 中图标不显示，同时 `.desktop` 出现 `entry=[object Object]`。

`release/v1.5.0` 的 `7e31388e` 已修正资源和配置：

- electron-builder 25 使用扁平的 `linux.desktop` 字段；Full 和 Lite 均设置 `StartupWMClass` 与 `Keywords`。
- `linux.icon` 指向 `build/icons`；从 `frontend/public/favicon.svg` 生成 16、24、32、48、64、128、256、512px PNG。
- Debian 包将图标安装到 `usr/share/icons/hicolor/<尺寸>/apps/nowen-note.png`，与桌面入口的 `Icon=nowen-note` 对应。

## 回归与产物检查

跨平台运行配置、图标生成、electron-builder 图标解析和解包目录检查的回归：

```sh
npm run test:linux-desktop
```

Linux 下构建和检查实际 Debian 包：

```sh
sudo apt-get install desktop-file-utils
npx electron-builder --config electron/builder.config.js --linux deb --publish never
npm run verify:linux-desktop
# 也可指定单个 .deb 或另一个产物目录
npm run verify:linux-desktop -- /path/to/nowen-note.deb
```

打包前仍需按项目构建流程准备前后端和 Linux 原生模块。检查器调用 `dpkg-deb --extract`，在临时目录中检查桌面字段、图标名称对应关系以及全部 8 种 PNG 尺寸，再执行 `desktop-file-validate`。检查完成后清理临时目录，不安装软件。

Linux 专项 CI 监听 `release/**`，构建 `.deb` 后运行此检查；正式发布工作流在上传 Linux 产物前也执行检查。回归覆盖 Full/Lite 配置，产物检查覆盖传入目录中的全部 `.deb`。

## 安装验收

产物检查不能代替桌面环境验收。正式版本发布前，仍需在 Linux Mint Cinnamon 安装新包，确认菜单和复制到桌面的入口显示正确图标，并可启动应用。如果桌面保留了旧版本手动复制的 `.desktop`，应从 `/usr/share/applications/nowen-note.desktop` 重新复制后再检查。
