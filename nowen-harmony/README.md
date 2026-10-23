# Nowen Note · HarmonyOS

鸿蒙版直接打包安卓使用的 React 前端，首页、导航、笔记列表、编辑器、任务、设置和登录入口共用业务代码。
ArkWeb 从应用内的 `https://localhost/` 加载资源，无需服务器也能进入“仅此设备”模式。

## 架构与数据边界

- `scripts/build-harmony-web.mjs` 构建共用前端并复制到被 Git 忽略的 `entry/src/main/resources/rawfile/web/`。
- `runtime/harmony-runtime.js` 在业务代码之前注册 Harmony 原生平台和 Capacitor 插件适配。平台标识保持 `harmony`。
- `NativeDatabase.ets` 将共用 `NativeDatabase` / `NativeLocalRepository` 的 SQL 映射到 Harmony RDB；沿用账号哈希、数据库迁移、事务、Outbox 和同步引擎。
- `NativeFiles.ets` 提供应用私有目录内的附件读写、分块校验和重命名；`WebAssets.ets` 提供内置资源和本地附件 URL。
- `NativeHost.ets` 提供原生 HTTP、系统 Asset Store 安全存储、网络、状态栏和外部浏览器。SQLite 操作串行，慢网络请求不会占用本地数据库队列。
- `WebViewPage.ets` 接入共享返回键逻辑、键盘、安全区、网络变化和系统文件选择器。原生代理只授权内置 HTTPS origin，阻止主页面跳转到其他来源。

业务数据和 Outbox 在同一事务内提交，失败时共同回滚。仅此设备模式不发送同步请求；本地保存成功不表示服务器已确认。
安全存储仅在 Harmony 构建中替换第三方 Web 实现，凭据写入系统 Asset Store，失败时不会退回明文 localStorage。
原有服务器配置页和偏好保留用于旧版兼容，新的服务器绑定和登录入口使用共用前端。升级不会清空旧来源的 Web 存储或迁移其中的凭据。

## 构建

需安装前端依赖、DevEco Studio 和 HarmonyOS SDK，并完成首次运行协议确认。
以下命令在仓库根目录执行，默认 DevEco 安装在 `/Applications/DevEco-Studio.app`：

```bash
npm run build:harmony:web
cd nowen-harmony
env NODE_HOME=/Applications/DevEco-Studio.app/Contents/tools/node \
  JAVA_HOME=/Applications/DevEco-Studio.app/Contents/jbr/Contents/Home \
  DEVECO_SDK_HOME=/Applications/DevEco-Studio.app/Contents/sdk \
  /Applications/DevEco-Studio.app/Contents/tools/hvigor/bin/hvigorw \
  --mode module -p product=default -p module=entry@default \
  -p buildMode=debug assembleHap --no-daemon
```

未配置签名时输出 `entry/build/default/outputs/default/entry-default-unsigned.hap`。
每次更新前端后都必须重新执行 `build:harmony:web` 再构建 HAP。
也可在 DevEco 中打开 `nowen-harmony/`、同步项目并运行。

`agconnect-services.json` 是服务配置，不能替代签名证书和 Provision Profile。
真机安装和发布需要单独配置签名；模拟器安装成功不代表真机或发布验收通过。

## 模拟器

已使用 DevEco Studio 26.0.0.851、HarmonyOS 6.1.1 / API 24 ARM64 手机镜像构建调试。
通过 Device Manager 下载镜像并创建设备后，可使用官方 CLI 启动：

```bash
/Applications/DevEco-Studio.app/Contents/tools/emulator/Emulator \
  -start NowenNote_API24 \
  -instancePath "$HOME/.Huawei/Emulator/deployed" \
  -imageRoot "$HOME/Library/Huawei/Sdk"
```

设备名和路径按本机配置替换。首次启动需要完成系统输入法设置。安装和启动：

```bash
/Applications/DevEco-Studio.app/Contents/sdk/default/openharmony/toolchains/hdc \
  -t 127.0.0.1:5555 install nowen-harmony/entry/build/default/outputs/default/entry-default-unsigned.hap
/Applications/DevEco-Studio.app/Contents/sdk/default/openharmony/toolchains/hdc \
  -t 127.0.0.1:5555 shell aa start -a EntryAbility -b com.nowen.note
```

## 回归验证

```bash
npm run test:harmony
node scripts/data-consistency-contract.mjs --verify
# 先构建内置前端并启动模拟器，再运行：
npm run test:harmony:emulator
```

`test:harmony` 执行真实 ArkTS 适配器的 SQLite 持久化、事务回滚、账号隔离、桥接回调、附件分块和启动顺序测试。
前端 `harmonyNativeAdapters.test.ts` 将同一适配器测试纳入 DCC-002/003/006/009；
`harmonySecureStorage.test.ts` 检查安全存储桥、作用域隔离及失败不降级。

模拟器测试临时打包测试页面，直接调用共用 Repository、附件存储和安全存储，在隔离测试账号中写入中文笔记及 500KB 附件，
强制停止并重启应用后核对内容、Outbox、事务失败回滚和账号隔离。测试结束（包括失败）恢复正常应用入口、移除测试页面并重新构建安装。
不会清空用户账号、数据库或待同步数据。可通过 `HDC_TARGET` 和 `DEVECO_STUDIO_HOME` 覆盖设备标识及 DevEco Contents 路径。

2026-10-17：上述模拟器数据测试通过；正常界面也完成新建富文本笔记、中文标题/正文输入、显示“已保存到本机”、强制重启后列表及正文恢复验证。
临时界面测试笔记已移到回收站，正常应用入口已恢复。此结果不包含服务器往返或真机验收。

## 尚需验收

华为应用市场上架材料和当前缺项见 [上架准备记录](distribution/release-readiness.md) 与[文案草稿](distribution/store-listing.zh-CN.md)。

共用前端并不意味着每个 Android 插件已经移植。以下能力不能据此视为完成：

- 实际服务器登录、Sync V2 双设备往返与故障恢复，需要可用服务器和测试账号验证。
- 中文输入法下的光标/候选词、文件选择和取消、大附件/视频播放需真机交互验收。
- Android 专有的相册导出、HEIC 转码、媒体缓存、指纹快捷登录、分享接收和推送需要对应 Harmony 原生实现。
- 当前 HAP 未签名；尚未完成真机签名安装、商店审核或发布。
