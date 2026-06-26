---
name: chinese-reply
description: Force AI to always respond in Chinese (中文). Use this skill at the start of any conversation to ensure all responses are in Chinese.
---

# Chinese Reply

确保AI始终使用中文回复。

## 规则

1. **所有回复必须使用中文** — 包括解释、注释、错误信息等
2. **技术术语保持英文** — 如 `function`, `variable`, `component` 等代码相关术语
3. **代码注释使用中文** — 除非是变量名或函数名
4. **错误提示使用中文** — 帮助用户理解问题

## 使用方法

在对话开始时调用此skill，AI将自动使用中文回复所有后续内容。

## 示例

```
用户: 帮我写一个函数
AI: 好的，我来帮你写一个函数。这个函数的功能是...
```

```
用户: 这段代码有什么问题？
AI: 这段代码有几个问题：
1. 变量 `x` 未定义
2. 缺少返回值
```