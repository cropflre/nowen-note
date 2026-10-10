# 损坏 Git ref 备份记录

日期：2026-08-20
仓库：C:\UGit\nowen-note

## 问题

`git fetch origin` 失败：

```
fatal: bad object refs/codex/turn-diffs/checkpoints/e86959cac7abcf455aa27e85d49b1038e4235a77e3f54d147e5414da81ae6de6/940467e8ae2266e32b9dffb27ea49991e52990638092270105154098b0b70f8d/1786701874210/0d3fc2a7-cdb0-4dbb-a403-6d64219db0e2
error: https://github.com/cropflre/nowen-note.git did not send all necessary objects
```

## 损坏的 ref（唯一一个）

```
ref:  refs/codex/turn-diffs/checkpoints/e86959cac7abcf455aa27e85d49b1038e4235a77e3f54d147e5414da81ae6de6/940467e8ae2266e32b9dffb27ea49991e52990638092270105154098b0b70f8d/1786701874210/0d3fc2a7-cdb0-4dbb-a403-6d64219db0e2
指向: 994fd81a18e7543ed7b83500e3759cad460ff8f2
```

## 删除前的核实结论

- `git cat-file -t 994fd81a...` → `could not get object info`（对象不在库中）
- `git branch -a --contains 994fd81a...` → `no such commit`（无任何分支可达）
- 仅此一个 ref 指向该对象，无其他引用
- 命名空间为 `refs/codex/turn-diffs/checkpoints/`，属于 Codex 工具的临时 checkpoint，
  **不是** branch / release branch / tag / 用户源码提交
- 同命名空间下另外 3 个 codex ref 对象完整，未受影响，保留不动：
  - `9185f8648eb1041a9c1d2a0afcb3c4c999ecef09` (…afb0ef62…/1787218997885/5e4eb9de…)
  - `b0d759a3a3414b00d8a1f345ea2bf006b04e7bc3` (…d0754478…/1786700744900/530f71ff…)
  - `aa684acc07ddb3afd9bfcb615e62e289dde4b461` (…d1f5c524…/1786701987088/9924935b…)

## 采取的操作

`git update-ref -d <ref>` —— 标准 Git 操作。

未执行：手工删 pack、`reset --hard`、删除任何 branch、删除任何源码。

## 恢复方式

该 ref 指向的对象已不存在于本地库，无法恢复，也无恢复价值
（Codex checkpoint 是编辑过程快照，非用户提交）。
若将来需要，可从 Codex 工具自身的历史中重建。
