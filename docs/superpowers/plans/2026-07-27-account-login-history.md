# 多账号登录历史实现计划

**目标：** Electron 桌面端和 Capacitor 移动端保存全部成功登录过的账号，并允许用户从登录页或侧栏点击切换。

**安全边界：** 不保存密码；账号元数据可保存在本地索引中，登录令牌必须使用 Electron `safeStorage` 或移动系统安全存储。切换前验证目标令牌，网络失败不改变当前会话，明确失效时保留账号元数据并进入预填重登。

## 任务 1：安全存储适配

- 修改 `electron/credentials.js`，增加与旧“连接中心”无关的 account-history 加密记录及严格 IPC 校验。
- 修改 `electron/preload.js` 和 `frontend/src/lib/desktopBridge.ts`，暴露最小化历史令牌接口。
- 新增 Electron 回归测试，覆盖保存、排序、解密、删除、损坏令牌和旧 profiles 清理。
- 验证：`node --test electron/__tests__/accountLoginHistory.test.js electron/__tests__/credentialsProfileRemoval.test.js`。

## 任务 2：跨平台账户历史核心

- 新增 `frontend/src/lib/accountLoginHistory.ts`，统一元数据、Electron safeStorage、Capacitor SecureStorage 与待重登状态。
- 新增 `frontend/src/lib/accountLoginSwitch.ts`，实现“先验证、后切换”，区分令牌失效与网络错误。
- 新增 Vitest，覆盖多账号去重、最近使用排序、移动安全存储、成功切换、网络失败不切换和失效重登。
- 验证：`npx vitest run src/lib/__tests__/accountLoginHistory.test.ts src/lib/__tests__/accountLoginSwitch.test.ts`。

## 任务 3：登录流程和界面接入

- 在 `AuthGate` 的所有成功登录/校验路径中写入历史。
- 新增复用的账号历史选择组件；登录页展示历史账号，侧栏提供当前账号菜单、切换、添加账号和删除历史。
- 失效账号点击后打开登录页并预填服务器与用户名；退出当前会话不删除历史。
- 添加中英文文案和 UI 合同测试，确保不恢复已删除的连接与迁移中心。
- 验证：运行相关组件测试与现有登录/移除功能回归测试。

## 任务 4：整体校验

- 运行目标 Electron/前端测试。
- 运行 `npm run build`（frontend）。
- 检查 `git diff --check`、`git status --short`，只保留本需求文件。
