# 审计用例与证据

| 编号 | 要求→源码 | 操作和核心断言 | 当前结果 / 原始证据 |
| --- | --- | --- | --- |
| QA-BASE | 固定 release HEAD | 两次 ls-remote 一致；本地祖先与dirty状态；被测checkout tracked diff为空 | VERIFIED / baseline.json |
| QA-DEL-01 | DELETE 活动笔记→notes/adapter/ACL | owner活动笔记删除；notes/history/独占附件/tree消失，restore failure；重开仍缺 | DEFECT_REPRODUCED / boundary-audit.json |
| QA-DEL-02 | 真公开入口→hardened/auth/capability | 无JWT伪造头401；其他账号403；实际登录owner200→GET404→restore failure | DEFECT_REPRODUCED / http-bundle-proof.json |
| QA-DEL-03 | 锁定与软删→adapter/notes | locked403；软删保持正文且可恢复；去重附件最后引用才删除 | VERIFIED 部分范围 / boundary + note-delete-attachments 7/7 |
| QA-DEL-04 | 同步→capture migration | 启用ready profile + identity，gate=1；DELETE保存baseVersion=4墓碑 | VERIFIED DB层 / boundary；跨端实机 NOT_TESTED |
| QA-STUDIO-01 | 隔离→projectPaths/service | 真symlink/junction拒绝且不读外部字节；traversal、.env、跨用户拒绝 | VERIFIED Windows负例 / boundary.studio + 原测试5/5 |
| QA-STUDIO-02 | 硬链接→read/export | 同卷本地创建nlink=2链接，读取/导出带出外部canary | DEFECT_REPRODUCED（本地前提）/ boundary.studio |
| QA-STUDIO-03 | ZIP导入→importProject | Unix symlink entry成为普通文件，未读外部目标 | VERIFIED该样本 / boundary.studio.zipLink |
| QA-STUDIO-04 | check/open时序→resolve/readFileSync | 本地受控插桩在检查后换链接，service读出外部canary | GAP_REPRODUCED；真实并发/远程 NOT_TESTED |
| QA-I18N | 生产组合资源→index/coverage | zh-CN/en直接资源检查，生产初始化后原组件文字断言通过 | 原诊断否定 / production-i18n*.json |
| QA-CONSTRAINT | 准确错误→notes.ts catch | 新ID省略notebookId=NOTNULL却409；合法201；真实重复=PRIMARYKEY/409 | DEFECT_REPRODUCED / boundary.constraint |
| QA-UI-ADDR | 恢复已存连接→LoginPage/ServerAddressInput | autofocus blank→savedHost，LAN隐藏但可见地址为空，三轮原用例失败 | DEFECT_REPRODUCED DOM / address-proof + dom观察 |
| QA-FRONT-14 | 原历史14失败 | 原9文件55用例全跑；4文件三轮；逐项不弱化断言归因 | 见F01–F14独立表；历史crypto原名UNKNOWN |
| QA-BACK-5 | 原后端5非PASS | 逐文件隔离、原测试/120s阈值，原始TAP计数 | 本轮22/22；历史原因部分不能定因 |
| QA-AUTO | aa49→99db受影响模块 | automation-platform全部4例，包括损坏payload隔离 | PASS4/4 / backend-rest |
| QA-EXPORT | 下载真实产物→export/jobs | POST202→ready→HTTP下载200→ZIP正文解包→SHA256 | PARTIAL闭环；再导入未测 / http-export.zip |
| QA-UPGRADE | v1.5.0→当前schema | 原正式v1.5.0源库fixture、schema122→123、二次启动、备份当前/旧版回读 | PASS既有fixture1/1 / encrypted-notes-upgrade.log |
| QA-ANDROID | 原生端真实矩阵 | 正式最终APK的27项设备步骤；收尾只读查到已连接PJZ110和旧正式包1.5.1 | NOT_TESTED / android-acceptance-matrix.md |

“VERIFIED”只用于表格明确的环境与断言；“DEFECT/GAP_REPRODUCED”表示坏行为确实发生，不是质量 PASS。完整功能没有共同分母，本表不换算覆盖百分比。
