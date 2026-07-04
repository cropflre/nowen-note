# macOS 安装说明

## 下载包提示“已损坏”

如果 macOS 提示：

```text
“Nowen Note” 已损坏，无法打开。你应该将它移到废纸篓。
```

这通常不是机器性能问题，也不是应用已经启动后的崩溃，而是 macOS Gatekeeper 在启动前拦截了未完成公证或带有隔离标记的下载包。Chrome、Safari 等浏览器下载的应用会带上 `com.apple.quarantine` 标记。

## 临时绕过

如果应用已经拖到“应用程序”目录：

```bash
xattr -dr com.apple.quarantine "/Applications/Nowen Note.app"
open "/Applications/Nowen Note.app"
```

如果应用还在“下载”目录：

```bash
xattr -dr com.apple.quarantine "$HOME/Downloads/Nowen Note.app"
open "$HOME/Downloads/Nowen Note.app"
```

如果是从 `.dmg` 打开，建议先把 `Nowen Note.app` 拖到“应用程序”，再执行上面的命令。

## 正式发布要求

面向普通用户发布的 macOS 包应满足：

1. 使用 Developer ID Application 证书完成代码签名。
2. 使用 Apple notarization 完成公证。
3. Apple Silicon 用户优先下载 `arm64` 包。
4. Intel Mac 用户下载 `x64` 包。

本项目的 macOS 产物文件名包含架构，例如：

```text
Nowen Note-1.2.5-arm64.dmg
Nowen Note-1.2.5-x64.dmg
```

未签名或未公证的测试包可以用上面的 `xattr` 临时打开；正式 release 不应要求用户执行该命令。
