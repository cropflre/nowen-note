## 本次修改

<!-- 简述修改内容和用户可见效果。 -->

## 数据一致性 / 用户数据安全（涉及用户数据时必须填写）

参阅 [数据一致性契约](../docs/architecture/data-consistency-contract.md) 与 [契约测试矩阵](../docs/architecture/data-consistency-contract.matrix.json)。无关的纯样式改动可勾选「不涉及用户数据」，并说明原因。

- [ ] 本 PR 不涉及数据写入、同步、离线缓存、删除、附件、导入导出、备份恢复或账号切换（理由：____）
- [ ] **本地持久化**：明确了事务成功边界，不把乐观 UI 更新当成持久化成功（DCC-002）
- [ ] **服务端确认**：不会把入队、请求发送或缓存命中误显示为“云端已同步”（DCC-001 / DCC-010）
- [ ] **故障与重试**：覆盖断网、超时、401/403、5xx、重复请求及重启，不静默清空待同步数据（DCC-003 / DCC-009）
- [ ] **并发冲突**：保留双方版本，非用户意图不覆盖或删除数据（DCC-004 / DCC-007）
- [ ] **同步游标和身份**：未成功校验/应用不推进游标，跨账号/Profile 数据隔离（DCC-005 / DCC-006）
- [ ] **恢复风险**：涉及备份、迁移或附件时有完整性校验与失败回滚方案（DCC-008）

### 本次涉及的契约编号和验收记录

<!-- 如 DCC-002、DCC-004；若不适用，说明原因。 -->
- DCC 编号：
- 断网 / 冲突 / 失败复现与处理：
- 新增或更新的回归测试：
- 如有数据迁移：回滚 / 兼容旧数据方案：

### 本地回归检查

```bash
node scripts/data-consistency-contract.mjs --verify
# 修改了后端/同步逻辑时：
node scripts/data-consistency-contract.mjs --backend
# 修改了前端/离线/Native 逻辑时：
node scripts/data-consistency-contract.mjs --frontend
```

- [ ] 契约映射检查通过
- [ ] 相关真实行为测试通过
- [ ] 已解释未覆盖的真实设备 / Docker / 数据库组合与发布风险
