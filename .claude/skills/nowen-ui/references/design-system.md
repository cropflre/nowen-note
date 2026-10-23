# NOWEN Design System Reference

## 1. Semantic token model

NOWEN's theme engine applies a complete palette to CSS variables and switches a root `.dark` or `.light` class. Components consume semantic variables, allowing the same component geometry to work across sixteen palettes.

### Required semantic variables

| Group | Variables |
|---|---|
| Brand | `--color-primary`, `--color-primary-light`, `--color-primary-dark` |
| Accent | `--color-accent`, `--color-accent-light` |
| Background | `--color-bg-primary`, `--color-bg-secondary`, `--color-bg-tertiary`, `--color-bg-gradient` |
| Text | `--color-text-primary`, `--color-text-secondary`, `--color-text-muted` |
| Border | `--color-border`, `--color-border-light` |
| Glass | `--color-glass`, `--color-glass-border`, `--color-glass-hover` |
| Elevation | `--color-shadow`, `--color-shadow-hover` |
| Energy | `--color-glow`, `--color-glow-secondary` |

Compatibility aliases such as `--gradient-1` and `--gradient-2` may map to primary and accent, but new code should prefer the semantic `--color-*` contract.

## 2. Default Deep Space palette

```css
--color-primary: #667eea;
--color-primary-light: #818cf8;
--color-primary-dark: #4f46e5;
--color-accent: #06b6d4;
--color-accent-light: #22d3ee;
--color-bg-primary: #0a0a0a;
--color-bg-secondary: #0f0f12;
--color-bg-tertiary: #171720;
--color-bg-gradient: radial-gradient(ellipse 80% 50% at 50% -20%, rgba(102, 126, 234, 0.15), transparent);
--color-text-primary: rgba(255, 255, 255, 0.95);
--color-text-secondary: rgba(255, 255, 255, 0.72);
--color-text-muted: rgba(255, 255, 255, 0.45);
--color-border: rgba(255, 255, 255, 0.1);
--color-border-light: rgba(255, 255, 255, 0.05);
--color-glass: rgba(23, 23, 32, 0.5);
--color-glass-border: rgba(255, 255, 255, 0.1);
--color-glass-hover: rgba(255, 255, 255, 0.05);
--color-shadow: none;
--color-shadow-hover: none;
--color-glow: rgba(102, 126, 234, 0.5);
--color-glow-secondary: rgba(6, 182, 212, 0.4);
```

## 3. Default Solar Clarity palette

```css
--color-primary: #3b82f6;
--color-primary-light: #60a5fa;
--color-primary-dark: #2563eb;
--color-accent: #6366f1;
--color-accent-light: #818cf8;
--color-bg-primary: #fafafa;
--color-bg-secondary: #ffffff;
--color-bg-tertiary: #f4f4f5;
--color-bg-gradient: radial-gradient(ellipse 100% 80% at 0% 0%, rgba(219, 234, 254, 0.5), transparent 50%);
--color-text-primary: #171717;
--color-text-secondary: #525252;
--color-text-muted: #a3a3a3;
--color-border: rgba(0, 0, 0, 0.08);
--color-border-light: rgba(0, 0, 0, 0.04);
--color-glass: rgba(255, 255, 255, 0.85);
--color-glass-border: rgba(0, 0, 0, 0.05);
--color-glass-hover: rgba(255, 255, 255, 0.95);
--color-shadow: 0 1px 3px rgba(0,0,0,0.04), 0 8px 30px rgba(0,0,0,0.04);
--color-shadow-hover: 0 4px 12px rgba(0,0,0,0.06), 0 20px 40px rgba(0,0,0,0.08);
--color-glow: rgba(59, 130, 246, 0.15);
--color-glow-secondary: rgba(99, 102, 241, 0.1);
```

## 4. Theme palette index

The original system contains eight dark and eight light palettes. The table below captures each palette's identity anchors. Derive secondary values using the default contracts when creating a smaller implementation.

### Dark themes

| ID | Name | Primary | Accent | Base background |
|---|---|---:|---:|---:|
| `nebula` | 星云夜空 | `#667eea` | `#06b6d4` | `#0a0a0a` |
| `aurora` | 极光幻影 | `#a855f7` | `#f472b6` | `#09090b` |
| `ocean` | 深海迷境 | `#0ea5e9` | `#2dd4bf` | `#020617` |
| `forest` | 暗夜森林 | `#22c55e` | `#a3e635` | `#030806` |
| `volcano` | 熔岩灼烧 | `#ef4444` | `#f97316` | `#0c0404` |
| `cyber` | 赛博朋克 | `#eab308` | `#84cc16` | `#0a0a08` |
| `midnight` | 午夜爵士 | `#6366f1` | `#d4a574` | `#060614` |
| `glacier` | 冰川极光 | `#67e8f9` | `#c4b5fd` | `#050a0e` |

### Light themes

| ID | Name | Primary | Accent | Base background |
|---|---|---:|---:|---:|
| `daylight` | 晴空白昼 | `#3b82f6` | `#6366f1` | `#fafafa` |
| `sunrise` | 日出暖阳 | `#f97316` | `#f59e0b` | `#fffbf7` |
| `sakura` | 樱花粉黛 | `#ec4899` | `#f43f5e` | `#fdf4f8` |
| `mint` | 薄荷清新 | `#10b981` | `#14b8a6` | `#f5fdf9` |
| `peach` | 蜜桃甜心 | `#f97066` | `#fb923c` | `#fff8f6` |
| `lavender` | 薰衣草梦 | `#8b5cf6` | `#c084fc` | `#faf8ff` |
| `cloud` | 云端漫步 | `#64748b` | `#0ea5e9` | `#f8fafc` |
| `amber` | 琥珀暖光 | `#d97706` | `#92400e` | `#fefcf3` |

## 5. Type system

### Families

```css
--font-ui: Inter, system-ui, -apple-system, sans-serif;
--font-editorial: "Playfair Display", Georgia, serif;
--font-technical: "JetBrains Mono", "Fira Code", monospace;
```

### Roles

| Role | Suggested styling |
|---|---|
| Hero time | 30–48px, 600, technical mono, tight tracking |
| Hero metadata | 14–16px, uppercase, 0.2em tracking |
| Editorial greeting | 16–20px, 500, serif, wide tracking |
| Section title | 20px, 500 |
| Card title | 14–16px, 500 |
| Card body | 12–14px, muted, 1.25rem line height |
| Micro label | 10–12px, medium |
| Telemetry value | Mono, tabular numerals |

## 6. Shape system

| Element | Radius |
|---|---:|
| Micro badge / kbd | 4–6px |
| Icon well / small button | 8–12px |
| Input / toolbar group | 12px |
| Standard card | 16px |
| Prominent card / access panel | 24px |
| Energy orb | 9999px |

The main interface should visibly favor 12px and 16px radii. Use 24px only for larger shells.

## 7. Spacing system

Use a 4px base grid.

- 4px: icon-label micro gap.
- 8px: compact control gap.
- 12px: card internals and toolbar gaps.
- 16px: default grid gap.
- 20px: standard card padding.
- 24px: large card or modal header padding.
- 32px: extra-large surface padding.
- 48px: major section separation.
- 64px: hero bottom spacing.
- 80px: hero top spacing.

## 8. Surface hierarchy

1. **Canvas** — `--color-bg-primary` plus atmosphere.
2. **Section grouping** — usually transparent; hierarchy comes from spacing.
3. **Primary card** — glass + 16px radius + border + Spotlight/elevation.
4. **Nested control well** — `--color-bg-tertiary`, 8–12px radius.
5. **Overlay** — `--color-bg-secondary`, clearer border, stronger shadow.
6. **Active energy state** — primary/accent alpha fill plus glow or diffuse shadow.

Do not place multiple equally strong glass layers inside one another without changing opacity or background tier.

## 9. Tags and badges

Stable hash palette:

- Blue: bg `rgba(59,130,246,0.12)`, text `rgb(96,165,250)`, border `rgba(59,130,246,0.25)`.
- Emerald: bg `rgba(16,185,129,0.12)`, text `rgb(52,211,153)`, border `rgba(16,185,129,0.25)`.
- Amber, red, violet, pink, cyan, and lime follow the same 0.12 / bright text / 0.25 border model.

Tag geometry:

- `px-1.5 py-0.5`.
- 6px radius.
- 10px text.
- Medium weight.
- Maximum width around 80px with truncation.

## 10. State colors

| State | Dark | Light |
|---|---|---|
| Normal telemetry | `#06b6d4` | `#0891b2` |
| Success / online | `#22c55e` | `#16a34a` |
| Warning | `#f59e0b` | `#ea580c` |
| Danger | `#ef4444` | `#dc2626` |
| Private badge | amber translucent | brown/amber higher contrast |

## 11. Wallpaper legibility

Use layered text shadows rather than a single heavy shadow:

```css
text-shadow:
  0 1px 3px rgba(0, 0, 0, 0.8),
  0 0 12px rgba(0, 0, 0, 0.4);
```

Secondary text can use slightly lower alpha. Add an adjustable dark overlay below content.
