# GitHub SignPath Windows 更新签名设计

## 背景

当前 Windows 桌面端在 `app-update.yml` 中声明 `publisherName: Nowen`，因此 `electron-updater` 下载 NSIS 更新包后会调用 Windows Authenticode 校验，并要求签名证书的发布者与 `Nowen` 匹配。现有 1.4.2 客户端、1.4.2 安装包和 1.4.3 发布包均未签名，导致自动更新在下载完成后以 `ERR_UPDATER_INVALID_SIGNATURE` 失败。

GitHub Artifact Attestation 只能证明产物来自指定 GitHub Actions 工作流，不能生成嵌入 Windows EXE 的 Authenticode 签名，因而不能直接满足 `electron-updater` 的校验。项目采用 SignPath Foundation 的免费开源签名服务：由 GitHub Actions 在 GitHub 托管 runner 上构建，SignPath 验证构建来源并使用其 HSM 中的证书签名，签名成功后再发布到 GitHub Release。

## 目标

- Windows Full 和 Lite 的自动更新安装包必须具有 Windows 信任的有效 Authenticode 签名。
- GitHub Release 只能接收已签名、发布者匹配且更新元数据与签名后文件一致的 Windows 产物。
- 缺少 SignPath 配置、签名被拒绝、签名超时、发布者不匹配或元数据校验失败时，发布流程必须失败关闭。
- 保留 macOS、Linux、Android、Docker 等现有发布目标，不把 Windows 签名改造扩展为无关的打包重构。
- 明确处理从旧发布者 `Nowen` 向 SignPath Foundation 证书发布者迁移时无法自动跨越的兼容性边界。

## 非目标

- 不生成或分发自签名根证书，也不要求用户手动信任私有 CA。
- 不使用 GitHub Artifact Attestation 替代 Authenticode；可在后续独立增加制品证明。
- 不在仓库或 GitHub Secrets 中保存 PFX 私钥。SignPath 私钥始终留在其 HSM 中。
- 本次只保证对外发布的 Windows 安装包和便携包签名，不扩展到所有第三方 DLL 的逐文件签名。
- 不保证 SignPath Foundation 接受申请；申请审批是启用正式签名的外部前置条件。

## 外部前置条件

正式启用前，项目维护者需要完成以下一次性操作：

1. 向 SignPath Foundation 申请免费开源代码签名并接受其条款。
2. 为 GitHub 账号启用多因素认证，并允许 SignPath GitHub App 访问 `cropflre/nowen-note`。
3. 在 SignPath 中建立项目、Artifact Configuration 和 release signing policy。
4. 将 SignPath 提供的 API token 保存为 GitHub Actions Secret `SIGNPATH_API_TOKEN`。
5. 将组织 ID、项目 slug、签名策略 slug、Artifact Configuration slug 和证书发布者 CN 分别保存为 GitHub Actions Variables：
   - `SIGNPATH_ORGANIZATION_ID`
   - `SIGNPATH_PROJECT_SLUG`
   - `SIGNPATH_SIGNING_POLICY_SLUG`
   - `SIGNPATH_ARTIFACT_CONFIGURATION_SLUG`
   - `NOWEN_WINDOWS_PUBLISHER_NAME`

`NOWEN_WINDOWS_PUBLISHER_NAME` 必须来自首个 SignPath 正式签名产物的实际证书 CN，不在代码中猜测或硬编码。GitHub Actions 在发布前再次从签名产物读取 CN 并要求精确相等。

## 代码签名政策

为满足 SignPath Foundation 的公开政策要求，README 的下载/发布说明增加“Code signing policy”章节，内容包括：

- 免费代码签名由 SignPath.io 提供，证书由 SignPath Foundation 提供。
- 源码仓库、维护者/审查者和签名批准者均指向 `cropflre/nowen-note` 及其维护者 `cropflre`。
- 将现有仅覆盖浏览器剪藏扩展的 `docs/PRIVACY.md` 扩展为同时覆盖桌面端，明确桌面端仅在用户配置或主动使用相应功能时连接其指定服务、GitHub 更新源及相关第三方服务；Code signing policy 链接该政策。
- 说明只有 GitHub Actions 从已提交源码产生的正式 Windows 发布产物可以请求签名。

## 构建与签名架构

### GitHub Actions 构建阶段

现有 `release.yml` 调整为“构建不发布”：

- Windows、macOS 和 Linux 的 `electron-builder` 均使用 `--publish never`。
- Windows Full 和 Lite 在 GitHub 托管的 `windows-latest` runner 上构建。
- Windows 构建输出按 Full/Lite 分开上传为 GitHub workflow artifacts。
- macOS、Linux 等其他平台继续上传 workflow artifacts，但不在矩阵任务内直接创建或更新 Release。

这样可以避免某个平台尚未验证完成时，另一个矩阵任务已经公开发布 Release。

### SignPath 签名阶段

Windows workflow artifact 上传到 GitHub 后，使用官方 `signpath/github-action-submit-signing-request` action 提交签名请求，并满足以下约束：

- 只接受来自当前仓库、当前 workflow run 和 GitHub 托管 runner 的 artifact。
- Artifact Configuration 只匹配当前版本的 Full/Lite setup 与 portable EXE。
- 每个匹配的 PE 文件执行 SHA-256 Authenticode 签名和时间戳。
- 通过产品名与产品版本限制，阻止用该策略签名其他程序或其他版本。
- 等待签名完成并下载签名后的 artifact；拒绝、失败或超时都使任务失败。

### 签名验证阶段

签名产物返回后，在 Windows runner 上逐个执行 `Get-AuthenticodeSignature`，要求：

- 状态为 `Valid`。
- `SignerCertificate` 存在。
- 证书 CN 与 `NOWEN_WINDOWS_PUBLISHER_NAME` 精确一致。
- 时间戳证书存在，或签名证书在验证时仍处于有效期内。
- Full 和 Lite 各自至少存在一个 NSIS setup 安装包；缺包不能以 portable 产物代替。

验证脚本不得输出证书私钥、API token 或完整 Secrets，只记录文件名、签名状态、发布者 CN 和证书指纹。

## 更新元数据处理

SignPath 在 `electron-builder` 生成 `latest*.yml` 后修改 EXE，文件大小和 SHA-512 必然变化。因此禁止直接发布构建阶段生成的 Windows 更新元数据。

签名验证通过后执行专用元数据刷新脚本：

1. 读取 Full 的 `latest.yml` 和 Lite 的 `latest-lite.yml`。
2. 只允许元数据引用各自签名后的 NSIS setup 文件。
3. 根据签名后文件重新计算 `size` 和 base64 SHA-512，同时更新顶层与 `files[]` 对应字段。
4. 保留版本号、路径和发布日期等其他字段，不重新排序无关内容。
5. 运行现有 updater metadata validator，确认版本、文件名、大小、SHA-512 和 blockmap 关系一致。

若 SignPath 返回的文件名与输入不同，签名阶段先按原始稳定文件名恢复，再刷新元数据；禁止通过模糊匹配选择候选安装包。

## 发布阶段

新增单一发布任务，依赖所有需要发布的构建与签名任务：

1. 下载各平台 workflow artifacts。
2. 再次运行版本同步、Windows 签名和更新元数据校验。
3. 创建或更新草稿 GitHub Release，并上传经过验证的产物。
4. 下载远端 Windows 更新元数据和对应 EXE，复核文件大小与 SHA-512。
5. 所有验证通过后才将草稿转为正式发布；任何失败都保留草稿并返回非零状态。

已有 `scripts/release.sh` 不再允许把本地构建的 Windows Full/Lite 产物直接上传到正式 Release。免费 SignPath 策略要求 GitHub 托管 runner 和可验证的 GitHub 构建来源，因此：

- 本地 `--build-only` 仍可生成未签名调试包，但必须明确标注不可发布。
- 本地发布目标包含 Windows Full/Lite 时，脚本在任何外部推送前失败，并提示通过 Git tag 或 workflow dispatch 触发 GitHub Actions。
- 不包含 Windows 的本地发布目标保持现有行为。

## 发布者迁移

现有 1.4.2/1.4.3 应用内嵌的发布者为 `Nowen`，无法接受由 SignPath Foundation 证书签名的新安装包。旧客户端的校验逻辑已经安装在用户机器上，不能通过修改远端 `latest.yml` 绕过。

因此首个 SignPath 签名版本采用一次性人工过渡：

- 发布说明明确要求 Windows 用户从 GitHub Release 手动下载并覆盖安装首个签名版本。
- 首个签名版本内嵌的 `app-update.yml` 使用 `NOWEN_WINDOWS_PUBLISHER_NAME` 对应的实际 SignPath 证书 CN。
- 从该版本升级到后续使用同一证书发布者的版本时，恢复正常自动更新。
- 不降低旧客户端的签名校验，也不发布伪装成 `Nowen` 的自签名证书。

## 错误处理

- SignPath 申请尚未通过：工作流允许完成普通测试和未签名 workflow artifact 构建，但正式 Windows 发布任务失败且不创建公开 Release。
- SignPath 配置缺失：在耗时构建前检查 Secret/Variables，列出缺失的配置名但不输出值。
- 签名请求等待人工批准：工作流保持运行并受明确超时限制；超时后失败，不能回退到未签名产物。
- 签名或发布者验证失败：删除本次任务工作目录中的候选签名产物并失败；已经存在的 Release 保持草稿。
- 签名后元数据不一致：重新计算一次仍不一致则失败，不能上传旧 `latest*.yml`。
- 远端复核失败：保持草稿，不更新 `latest` 可见发布。

## 测试与验证

实现采用测试驱动方式，至少覆盖：

- 构建配置在生产 Windows 发布时从 `NOWEN_WINDOWS_PUBLISHER_NAME` 写入 updater publisher，未配置时不能进入正式发布。
- GitHub workflow 不再在矩阵构建命令中使用 `--publish always`，并且发布任务依赖 Windows 签名任务。
- 缺少任一 SignPath Secret/Variable 时前置校验失败。
- 签名验证拒绝 `NotSigned`、`UnknownError`、空证书和错误 CN，只接受 `Valid` 且 CN 精确匹配的结果。
- 元数据刷新使用签名后 EXE 的真实大小和 SHA-512，并同时更新顶层与 `files[]` 字段。
- Full 与 Lite 元数据不会串用安装包。
- 本地发布脚本拒绝上传 Windows Full/Lite 未签名产物，但 `--build-only` 和非 Windows 目标不受影响。
- 现有 updater metadata、release guard 和 builder config 契约测试继续通过。

由于本地环境没有 SignPath 正式证书，仓库内验证只能证明失败关闭、配置契约、元数据重算和错误签名拒绝路径。真正的可信签名成功路径必须在 SignPath 申请通过后，通过一次 GitHub Actions 候选版本构建验证，并记录签名状态、发布者 CN、指纹、签名后 SHA-512 和远端草稿复核结果。

## 成功标准

- GitHub Actions 无法公开发布任何未签名的 Windows Full/Lite 更新包。
- 首个 SignPath 候选安装包在干净 Windows 环境中显示 Authenticode `Valid`，发布者与工作流配置一致。
- 签名后的 `latest.yml`/`latest-lite.yml` 能通过现有校验器，并与远端安装包大小和 SHA-512 完全一致。
- 手动安装首个 SignPath 签名版本后，测试客户端能通过应用内更新升级到下一个同发布者签名版本。
- macOS、Linux 和其他非 Windows 发布目标没有因本次改造发生无关行为变化。
