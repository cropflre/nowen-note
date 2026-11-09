# 华为应用市场上架准备

核对时间：2026-11-02。状态：**APP 备案已通过，华为版本草稿准备中，尚未提交审核**。

## 本轮核对与验证

2026-11-03 已完成候选前端连接正式环境的 AI 快记、保存重开及 PNG 元数据验收。详见 [AI 标识送审资料草稿](ai-review-materials.md)。

第三方检测识别了旧 PNG 的显式标识，但未识别 tEXt 中的隐式标识。最终候选包 `NowenNote-1.0.0-PNG-XMP-signed.app` 改用 iTXt 中的 TC260 XMP，已通过 DevEco 验签。SHA-256 为 `f40534cfbd2977e2c2d004039e79f782e167eb8bfecdb80df366484431d3428d`。对照样本的显式和隐式标识均通过检测，当前导出代码可逐字节复现该样本。待从该签名包导出真实 AI 笔记并留存原件。

同日已生成包含上述修复的签名候选包 `NowenNote-1.0.0-1000000-AIGC-candidate-signed.app`，通过 DevEco 签名工具验签。SHA-256 为 `1ae0ea53a02d787af165ac68e29d041ce4008816714a940ba5ee2a8249648ef7`。已在华为云真机验证安装、AI 快记显式标识及保存重开。PNG 导出界面报告完成，原文件落盘和元数据仍待核实。个人开发者说明函签署方式仍待确认。以下 2026-11-02 的旧包记录仅供追溯。

- 源码基线：`b2c3fa1ea`（`release/v1.5.4`），本轮新增鸿蒙“设置 → 关于”中的 APP 备案号和工信部查询入口，中文 / 英文标签齐备。入口随鸿蒙构建打包，使用原生 Browser 桥打开查询网站，不依赖所连接服务器的网站备案配置。
- 腾讯云已核对：服务状态正常，APP 备案号 **粤ICP备2026067978号-2A**，名称“弄文笔记”，运行平台“鸿蒙”，包名 `com.nowen.note`，后台域名 `hm.nowen.cn`。
- 华为 `1.0.0`（`1000000`）草稿已选中 `nowen-harmony-default-signed.app`，控制台上传时间为 2026-10-21 14:13:38。该旧包不含本轮新增的备案展示，不能把旧包选中视为当前源码已发布。
- 已按备案记录将主办单位设为“个人 / 与开发者账号主体一致”，保存草稿并收到“保存成功”。华为自动使用既有实名认证信息；随后通过“校验证件号”完成核验，页面显示“验证通过”；负责人手机验证已完成并保存。
- 当前草稿已有应用介绍、简介、截图图像、隐私政策与用户协议选项；年龄分级为中国区 8+，AI 声明为涉及文本生成。以上仅记录表单现状，仍需核对最终包、政策正文和审核要求。
- 隐私标签已保存草稿，覆盖应用功能、可选第三方模型内容处理及用户配置境外服务时的传输。
- 当前分发范围为全球 200 个国家或地区及新区域，表单原有跨境声明为勾选状态；本轮没有更改。提交前需确认实际分发范围及相应协议。
- `npm run test:harmony`：6 项通过；`npm run build:harmony:web`：TypeScript 与鸿蒙模式 Vite 构建通过；DevEco `assembleApp` Release 构建通过。构建存在原有 ArkTS 弃用 / 异常处理提示，并明确跳过签名。
- 本轮新产物 `build/outputs/default/nowen-harmony-default-unsigned.app` 尚未签名，SHA-256 为 `4f9b3c35d1efc9e0aeea2a4670b8fd1478f87594325e2c8f3a6daebbadac5405`。解包确认 `debug=false`，包含备案号及工信部查询链接，且不含 smoke 测试页面。现存旧 `signed.app` 也未完成与备案登记证书的指纹比对；使用 SDK HAP 验签工具检查其内层 HAP 未取得有效签名结果，不能据此断定外层 App Pack 无效，也不能把文件名视为验签证据。
- 没有启动模拟器或执行真机验收；没有上传本轮新包、提交审核、发布、提交 Git 或推送。

以下为 2026-10-17 的初始准备记录；与上文冲突的状态以上文本轮核对为准。

## 已核对

- 华为开发者账号：已认证的个人主体（不在仓库保存证件号、电话或其他认证资料）。
- 已有应用：弄文笔记，包名 `com.nowen.note`，控制台已有“新版本 - 准备提交”。
- 当前 Release App Pack 可构建，包内 `app.debug=false`、`buildMode=release`。
- 当前没有配置发布签名，输出为 `build/outputs/default/nowen-harmony-default-unsigned.app`。它不是可上传发布包。
- 已创建并保存“弄文笔记隐私政策”华为托管草稿，包含本机/服务器边界及用户指定的公开联系邮箱；尚未生成正式协议，第三方组件、权限明细及生效日期仍需完善。
- 应用声明 INTERNET、GET_NETWORK_INFO 两项权限；系统文件选择器采用用户主动选择文件的方式。
- 内置共用前端及 Harmony 运行时；测试页面没有打入正式 App Pack。
- 源码阶段已有模拟器持久化、附件、事务失败回滚和账号隔离证据；不等于签名后的候选包通过全部验收。
- 占位 emoji 图标已替换为项目现有品牌图标，系统显示名称与控制台中文名称一致。

## 当前控制台缺项

| 项目 | 当前情况 / 下一步 |
| --- | --- |
| 应用基础信息 | 控制台提示有必填信息未填写，需补全分类、图标等 |
| 发布软件包 | 尚未上传或选取；需发布证书、发布 Profile、对应私钥，再生成签名 Release `.app` |
| 简介、介绍与截图 | 尚未填写；文案见同目录草稿；手机截图按控制台规定准备实际画面 |
| 隐私声明 | 用户选择华为隐私托管，并已确认《用户隐私保护说明》；正在准备正式政策，尚未提交审核 |
| 隐私标签 | 尚未填写，必须依据实际数据处理行为填写，不能因原生权限少而声称没有个人信息处理 |
| AI 功能声明 | 尚未填写；共用前端存在 AI 入口，需实际审查功能及外发范围 |
| 内容分级 | 尚未完成问卷，不能猜测年龄类别 |
| APP 备案 / 核准 | 用户确认尚未办理，联网服务由用户自建服务器提供。需核实该客户端适用的备案/核准要求；控制台的单机选项不能仅依据“支持离线”勾选 |
| 负责人联系验证 | 需负责人手机号验证码、邮箱和姓名；本人完成身份验证，不在仓库记录 |
| 分发地区 | 控制台默认所有国家或地区并勾选跨境声明；尚未保存这些设置，需明确实际上架地区后确认 |
| 审核环境 | 准备专用可用服务器和测试账号；验证登录、同步、异常重试与数据保留，不使用生产凭据 |
| 发布验收 | 未覆盖的原生功能、真机/云测与隐私审核需要完成；不能用调试模拟器结果代替 |

## 隐私政策待核实的数据清单

这是工程事实清单，**不是已生效的隐私政策**。主体、联系方式、保存期限、权利请求途径和第三方服务需要本人确认后再生成正式政策。

| 场景 | 需要披露和核实的事项 |
| --- | --- |
| 仅此设备 | 笔记正文、附件和整理数据保存在应用私有存储，卸载/设备丢失的风险与备份方式 |
| 连接服务器 | 用户选择的服务器地址，登录账号及认证令牌；网络连接向所选服务器传输的数据和服务器运营方责任 |
| 同步 | 主动开启后笔记、附件和相关业务数据的传输范围；本地保存和服务端确认的区别 |
| 安全存储 | 记住登录等功能通过系统 Asset Store 保存相应凭据，不应把系统安全存储当作不处理个人信息 |
| 文件选择 | 只在用户主动选择文件后处理所选内容；不要声明拥有未申请的相册、通讯录或定位权限 |
| AI | 逐项核实可调用的服务、模型提供方、输入/上下文/附件外发内容、开关与告知；不默认视为本地 AI |
| 其他模块 | 任务、日历、分享、插件和远程资源等以实际候选包可访问的功能为准；检查依赖、启动联网和第三方数据接收方 |

当前自动生成的 `pac.json` 为 `dataProcess: []`、`specialAPIs: []`。这不证明应用没有个人信息处理，不能直接用于填“否”。

## 可重复构建

先在仓库根目录执行 `npm run build:harmony:web`，再进入 `nowen-harmony/`：

```bash
env NODE_HOME=/Applications/DevEco-Studio.app/Contents/tools/node \
  JAVA_HOME=/Applications/DevEco-Studio.app/Contents/jbr/Contents/Home \
  DEVECO_SDK_HOME=/Applications/DevEco-Studio.app/Contents/sdk \
  /Applications/DevEco-Studio.app/Contents/tools/hvigor/bin/hvigorw \
  --mode project -p product=default -p buildMode=release assembleApp --no-daemon
```

在 DevEco 配置合法的发布签名后重建。证书私钥、密钥库密码和 Profile 放在安全的本机位置，不能写入 Git、工单或聊天。
签名配置改变后检查暂存区，避免误提交 DevEco 写入的凭据。`agconnect-services.json` 不能替代发布签名。

## 官方依据

- [提交 HarmonyOS 应用](https://developer.huawei.com/consumer/cn/app/submit/)
- [华为应用市场审核指南](https://developer.huawei.com/consumer/cn/doc/app/50104)
- [App Pack 程序包术语](https://developer.huawei.com/consumer/cn/doc/doccenter-getting-started/application-package-glossary)
- [应用包签名与 Release 要求（云测试 FAQ）](https://developer.huawei.com/consumer/cn/doc/doccenter-testing/agc-help-cloudtest-faq-0000002255036920)
- [官方素材规格](https://developer.huawei.com/consumer/en/doc/agc-help-app-visual-asset-spec-0000002277607976)；当前版本表单显示的截图数量优先于文档旧值。
- [隐私托管](https://developer.huawei.com/consumer/cn/doc/app/agc-help-privacy-policy-overview-0000002316881805)
