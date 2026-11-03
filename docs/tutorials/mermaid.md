# Mermaid 流程图教程

> 用 Mermaid 语法在笔记中画流程图、时序图、甘特图。

---

## 什么是 Mermaid？

Mermaid 是一种用文本语法画图表的工具。在 nowen-note 中，你只需输入文本就能生成各种图表。

---

## 插入 Mermaid 图表

在编辑器中输入 `/Mermaid`，选择图表类型，然后输入内容。

---

## 流程图

```mermaid
graph TD
    A[开始] --> B{条件?}
    B -->|是| C[方案A]
    B -->|否| D[方案B]
    C --> E[结束]
    D --> E
```

**语法：**

```
graph TD
    A[节点文字] --> B{判断}
    B -->|条件1| C[结果1]
    B -->|条件2| D[结果2]
```

- `TD` = 从上到下（Top Down）
- `LR` = 从左到右（Left Right）
- `[]` = 矩形节点
- `{}` = 菱形判断节点
- `()` = 圆形节点

---

## 时序图

```mermaid
sequenceDiagram
    participant 用户
    participant 浏览器
    participant 服务器
    用户->>浏览器: 输入内容
    浏览器->>服务器: 保存请求
    服务器-->>浏览器: 保存成功
    浏览器-->>用户: 显示已保存
```

**语法：**

```
sequenceDiagram
    participant A
    participant B
    A->>B: 消息
    B-->>A: 回复
```

---

## 甘特图

```mermaid
gantt
    title 项目计划
    section 阶段一
    需求分析: 2024-01-01, 7d
    设计: 2024-01-08, 5d
    section 阶段二
    开发: 2024-01-15, 14d
    测试: 2024-01-29, 7d
```

---

## 类图

```mermaid
classDiagram
    class User {
        +String name
        +String email
        +login()
    }
    class Note {
        +String title
        +String content
    }
    User "1" --> "*" Note : has
```

---

## 状态图

```mermaid
stateDiagram-v2
    [*] --> 草稿
    草稿 --> 已发布 : 发布
    已发布 --> 草稿 : 撤回
    已发布 --> 已归档 : 归档
```

---

## 常见问题

### Q：Mermaid 图表不显示？

确认语法正确。可以在 [Mermaid Live Editor](https://mermaid.live/) 中测试。

节点文字含半角括号等特殊字符时，建议加双引号；注释使用 Mermaid 标准的 `%%`：

```mermaid
flowchart TD
    %% 判断重试次数
    A["调用方法(foo)"] --> B{"迭代次数超限?<br/>(e.g., >2次)"}
```

nowen-note 也会在原生渲染失败后，兼容流程图中独立成行的 `//` 注释，以及上述矩形、菱形等节点文字中的未加引号括号。兼容处理仅用于显示，不修改笔记源码；行尾 `//` 注释仍请改用 `%%`，需要跨工具使用时建议采用标准写法。

### Q：图表太小看不清？

在全屏模式下查看，或点击图表放大。

---

## 下一步

- [思维导图入门](./mindmap-intro.md) — 节点式思维导图
- [表格、代码块、数学公式](./advanced-blocks.md) — 其他高级内容块

---

> 本教程基于 nowen-note v1.1.18 编写。
