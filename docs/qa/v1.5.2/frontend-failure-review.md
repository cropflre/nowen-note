# 前端历史 14 失败逐项复核

原报告第一轮分类“Sync ×2 + 源码 ×6 + 待复跑 ×7”合计 15，与 14 不符；其待复跑清单实际列出 3+1+1+1=6，改为 2+6+6=14 才与数字一致。“1 个真缺陷”也是 Bug 个数和失败用例数混用。第二轮的 3+7+4=14 数学成立，但当前复跑不支持其中“3 个线上缺翻译”和“4 个偶发”的归因。

以下编号用于追踪；F14 的历史具体用例名无法从附件找回，保留 UNKNOWN，不编造。原 9 文件共 55 个用例全跑，实际重现 13 个失败，全部有 `evidence/*-r1.json`。仅改变诊断 setup 的结果另行记录，不覆盖失败日志。

| 编号 | 文件 / 失败断言 | 分类与根因 | 本轮结果和建议 |
| --- | --- | --- | --- |
| F01 | SyncStatusBadge.mobile：shows synced text on phones… | 测试契约/初始化缺失：测试未导入生产 i18n，输出 syncBadge.state.synced | 原测 FAIL；生产 setup 后原断言 PASS。配置测试初始化，保留保存→pending→ACK 断言 |
| F02 | SyncStatusBadge.mobile：waits for attachment bytes… | 同上，输出 syncBadge.pending | 原测 FAIL；生产 setup 后 PASS；不得把附件队列等待逻辑削弱 |
| F03 | ServerConnectionSettings：shows verified connection… | 同上，serverConnection.* 返回原键；合并资源本来已有翻译 | 原测 FAIL；生产 setup 后原断言 PASS；保留地址/账号/开关不串改断言 |
| F04 | removedConnectionFeatures：删除侧栏账号弹层并保留退出和本地恢复能力 | 测试契约过时：要求已不存在的 handleDesktopCloudButton；实际 handleSwitchToLocal | FAIL；58022ccf/8cea0f22 调整账号路径；AndroidAccountRail 现有行为测试 PASS。重写行为断言 |
| F05 | removedConnectionFeatures：版本冲突不再出现在数据管理同步卡片中 | 测试契约过时：要求 DataManager 中 summary.pending - summary.versionConflicts；8cea0f22 拆分并简化数据管理，旧卡片/计算已不在此处 | FAIL；按当前 SyncSettings/冲突快照入口验证，不能机械删除“保留本地正文”保护断言 |
| F06 | androidImmersiveEditorContract：removes nonessential metadata… | 测试契约过时：源码字符串要求条件卸载；59fa68e6 为保持标签输入焦点改为 mounted + hidden focus-within:block | FAIL；EditorTagInputKeyboard 两类 DOM 行为 PASS。保留收起与焦点继续输入的行为要求 |
| F07 | androidImmersiveEditorContract：applies same compact hierarchy… | 同上，Markdown 对应源码字符串过时 | FAIL；与富文本共同改行为契约；本轮没有实机键盘证明 |
| F08 | useAttachmentVideoRenderSource：waits for Android native cache… | 测试 Mock 契约过时：noteAttachmentAccessBridge 缺 requiresVerifiedAttachmentAccess 导出，Vitest 明确报错 | FAIL；补完整权限 Mock 并增加未授权不得下载负例，不能归 jsdom 偶发 |
| F09 | useAttachmentVideoRenderSource：原生动态缓存失败时暴露错误… | 同上 | FAIL；保留错误与封面退化断言 |
| F10 | useAttachmentVideoRenderSource：switches to late signed URL… | 同上 | FAIL；保留 late signed URL 与避免整段 blob 下载断言 |
| F11 | proxyCompatibility：narrowly maps Lucky/Nginx API rewrites… | 测试契约过时：要求精确单元素 exposeHeaders 字符串；526ccc5b 增加 X-Request-Id，兼容头仍在列表 | 三轮均 FAIL，非偶发；验证头集合和实际 CORS 响应，不禁止新增追踪头 |
| F12 | ShareModalClipboard：uses shared clipboard helper… | 测试契约过时：断言中文 toast 字面量，a1e5e7fe 改为 t("shareUi.copyFailed")，合并资源仍是同一文案 | 三轮均 FAIL，非偶发；保留共享 copyText、失败提示与复制状态隔离要求 |
| F13 | LoginPageLocalDesktopLogin：远程服务器地址下隐藏局域网发现 | **真实产品缺陷 BUG-07**：自动聚焦触发 editingRef=true，异步恢复 host 时跳过 displayText 更新，显示空地址 | 三轮 FAIL。诊断：localStorage 有 https://note.nowen.cn、LAN 元素已隐藏、三个 input 都为空；独立 autofocused 地址组件亦重现 |
| F14 | cryptoV2：历史超时失败的具体用例名 UNKNOWN | 未复现，历史原因未证实；不能直接归“偶发已解决” | 全文件 11 个用例三轮均 PASS（每轮进程约 5.7–6.0 秒）。需旧原始 JSON、用例名和并发负载记录才能定因 |

本轮 13 个可识别失败：12 个属于测试契约/Mock/初始化问题，1 个真实 UI 缺陷。尚没有本轮证据把任何一项归为已确认环境问题；历史 crypto 的“偶发/负载”归因仍未证实。这一分类描述**定向测试诊断**，不证明对应业务域已做全功能验收。

业务代码和原测试全部未改。6 条源码契约、3 条 Mock、3 条初始化需要按实际业务契约修复测试并维持有效负例；登录地址缺陷需要业务修复。完成后仍需全量执行，不能把补充探针全绿直接替代原套件失败。
