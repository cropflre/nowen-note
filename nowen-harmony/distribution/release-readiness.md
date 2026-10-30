# 华为应用市场上架准备

核对时间：2026-10-17。状态：**准备中，不能提交为可发布版本**。

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
