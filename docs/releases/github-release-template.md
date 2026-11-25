<!--
GitHub Release 发布说明模板（发版中心「正式发布说明」）。复制后替换所有〈…〉占位，并删掉这段注释。

- 第一行的 nowen-cloud 来源标记由发布脚本自动加上，不要手写。
- 「更新方式」一段用下面的命令生成，整段替换；--since 填上一个正式版的 Tag：

    node scripts/hot-update/update-mode.mjs --since v〈上一个版本〉

  如果命令在 stderr 提示「没有公钥」，说明这个提交打出的安装包不接受热更新。
  先按 docs/architecture/hot-update.md「第一个带热更新能力的整包」处理，再发版。
-->
## ✨ 更新亮点

**Nowen Note v〈版本〉 正式发布！** 〈一两句话说明本版重点〉

### 〈主题〉
- 〈用户能感知到的变化，附 Issue 编号〉

### 🛠️ 兼容性与其他改进
- 〈…〉

## 📦 下载与升级

支持 **Windows、macOS、Linux、Android、飞牛 fnOS、绿联 UGOS、Docker** 及浏览器剪藏插件。

[**官网下载中心**](https://nowen.cn/#/note/download) · [**完整更新日志**](https://github.com/cropflre/nowen-note/blob/main/docs/releases/v〈版本〉.md) · [**问题反馈**](https://github.com/cropflre/nowen-note/issues)

> **更新方式：** 〈用上面的命令生成，整段替换〉
>
> **升级提醒：** 升级前请备份数据库、附件及部署配置。回退客户端或 Docker 镜像**不会**回滚持久化数据库。
>
> **安装包签名：** GitHub 发布的 macOS 安装包未进行 Apple Developer ID 签名或公证，可能触发 Gatekeeper 提示；Windows GitHub 直接下载 EXE 也未提供代码签名，请从官方渠道获取。应用内的热更新包由项目自己的密钥签名，客户端验签通过后才会使用。

<details>
<summary>构建信息</summary>

- 发布日期：〈YYYY-MM-DD〉
- 源码提交：`〈完整 SHA〉`
- [正式构建记录](https://github.com/cropflre/nowen-note/actions/runs/〈Run ID〉)
- 壳版本号：安卓 `〈…〉`，电脑客户端 `〈…〉`（`node scripts/hot-update/runtime-fingerprint.mjs --revision v〈版本〉`）

</details>
