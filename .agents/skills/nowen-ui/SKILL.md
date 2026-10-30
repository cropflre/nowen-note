---
name: nowen-ui
description: >-
  Recreate, extend, or audit the NOWEN whole-site UI language: Deep Space / Solar Clarity themes, semantic CSS tokens, aurora backgrounds, glass Bento cards, Spotlight lighting, energy-orb docks, liquid motion, responsive admin surfaces, and performance-aware mobile fallbacks.
license: MIT
metadata:
  version: "1.0.0"
  source_repository: cropflre/NOWEN
  source_commit: c2e0a631e2d78a1dfe0e81ff32a81e259631fe16
---

# NOWEN Whole-Site UI Skill

Use this skill when designing, rebuilding, extending, or reviewing a page that should visually belong to the NOWEN product family.

The target is **not generic glassmorphism**. The visual identity combines:

- Deep, calm spatial backgrounds rather than flat black.
- Bright paper-like daytime surfaces rather than plain white.
- Semantic theme tokens instead of scattered hard-coded colors.
- Bento information architecture with restrained density.
- Glass surfaces with a clear hierarchy of background, border, blur, shadow, and glow.
- Mouse-aware Spotlight lighting on desktop.
- Liquid, spring-based motion that feels weighted rather than bouncy.
- Energy-orb navigation on desktop and a safe-area mobile dock.
- Strong typography contrast between time/data, editorial copy, and UI labels.
- Graceful feature reduction on mobile, low-power devices, and lite mode.

## 1. Required workflow

When this skill is invoked, follow this order:

1. Identify the target framework and preserve it unless the user explicitly asks for migration.
2. Establish or map semantic design tokens before styling individual components.
3. Build the page shell and background system.
4. Build primitive surfaces: card, button, input, badge, divider, modal, tooltip.
5. Assemble page-level layouts using Bento grids and restrained vertical rhythm.
6. Add motion only after the static hierarchy works.
7. Add desktop Spotlight/glow enhancements.
8. Add mobile and lite-mode fallbacks.
9. Verify dark, light, wallpaper, keyboard, mobile safe-area, and reduced-motion states.
10. Report changed files and visual acceptance results.

Do not start by scattering Tailwind color literals across the page.

## 2. Visual direction

### 2.1 Brand personality

NOWEN should feel:

- Quiet, futuristic, and personal.
- Technically capable without looking like an enterprise dashboard template.
- Atmospheric without sacrificing legibility.
- Premium through layering and motion, not through excessive decoration.
- Compact enough for information tools, but never cramped.

### 2.2 Core dual-mode model

**Deep Space — dark mode**

- Near-black layered backgrounds.
- Indigo/cyan or theme-specific energy colors.
- Semi-transparent glass surfaces.
- Thin luminous borders.
- Spotlight, border beam, glow, and breathing indicators.
- Shadows are minimized; light emission defines depth.

**Solar Clarity — light mode**

- Warm or cool off-white paper bases.
- White translucent cards.
- Hairline neutral borders.
- Multi-layer diffuse shadows.
- Subtle colored atmospheric gradients.
- Glow effects are replaced by elevation and soft shadow.

Never produce a light mode that is simply the dark mode with colors inverted.

## 3. Token-first implementation

Use the semantic variable contract in `assets/nowen-ui-tokens.css`.

Required groups:

- Brand: `--color-primary`, `--color-primary-light`, `--color-primary-dark`.
- Accent: `--color-accent`, `--color-accent-light`.
- Background: `--color-bg-primary`, `--color-bg-secondary`, `--color-bg-tertiary`, `--color-bg-gradient`.
- Text: `--color-text-primary`, `--color-text-secondary`, `--color-text-muted`.
- Border: `--color-border`, `--color-border-light`.
- Glass: `--color-glass`, `--color-glass-border`, `--color-glass-hover`.
- Elevation: `--color-shadow`, `--color-shadow-hover`.
- Energy: `--color-glow`, `--color-glow-secondary`.

Use semantic tokens in components. Hard-coded colors are acceptable only for meaningful states such as success, warning, danger, CPU load, or a deliberately fixed decorative effect.

## 4. Typography

Use three clearly separated type roles:

- UI and body: `Inter`, then system sans-serif.
- Editorial greeting, quote, or reflective copy: `Playfair Display`, then Georgia.
- Time, telemetry, counters, hashes, shortcuts, and technical values: `JetBrains Mono`, then a monospace fallback.

Rules:

- Hero time: `text-3xl sm:text-4xl lg:text-5xl`, semibold, tight tracking, mono.
- Date metadata: base size, uppercase, `tracking-[0.2em]`.
- Section title: around `text-xl`, medium, slightly expanded tracking.
- Card title: medium weight; truncate to one line.
- Card description: small, muted, one or two lines.
- Micro labels and counters: `text-xs`, muted, often mono or tabular numerals.
- Avoid oversized marketing headings. NOWEN is a personal command center, not a landing page.

## 5. Page shell and spatial rhythm

Default home shell:

```tsx
<div className="min-h-screen px-4 sm:px-6 lg:px-8 pb-32">
  <div className="max-w-6xl mx-auto">...</div>
</div>
```

Default vertical rhythm:

- Hero: `pt-20 pb-16`.
- Major sections: `mb-12`.
- Section heading to content: `mb-6`.
- Grid gaps: `gap-4` by default; `gap-3` for compact density; `gap-5` for comfortable density.
- Card padding: 16 / 20 / 24 / 32px size scale.
- Main radii: 12px for controls, 16px for normal cards, 24px for prominent shells.

Keep content centered and visually calm. Do not stretch core content edge-to-edge on wide screens.

## 6. Background system

A full NOWEN page should have at least three background layers:

1. Base color: `--color-bg-primary`.
2. Theme atmosphere: `--color-bg-gradient`.
3. Optional energy layers: mouse-following radial gradient, blurred floating orbs, meteors, beams, or wallpaper overlay.

Desktop dark mode may use:

- A primary radial gradient centered at mouse coordinates.
- Two or three secondary radial gradients at fixed corners.
- Slow scale and opacity breathing over 8–20 seconds.
- Large 400–700px blurred orbs.

Light mode should use stronger diffuse color but softer perceived contrast.

Mobile rules:

- Remove or freeze large blurred animated orbs.
- Avoid continuous mouse-following effects.
- Keep a static theme gradient.
- Preserve readability and battery life over spectacle.

Wallpaper mode:

- Put the image on its own fixed layer.
- Use a configurable dark overlay.
- Apply text shadows to hero copy.
- Never allow wallpaper contrast to destroy text legibility.

## 7. Core surfaces

### 7.1 Glass surface

A standard glass surface uses:

```css
background: var(--color-glass);
border: 1px solid var(--color-glass-border);
backdrop-filter: blur(24px) saturate(180%);
box-shadow: var(--color-shadow);
```

Light mode may increase blur to 40px and use a more opaque white.

### 7.2 Spotlight card

Default card:

- `relative overflow-hidden rounded-2xl backdrop-blur-xl`.
- Padding defaults to 20px.
- Hover lifts by 4px.
- Click/tap compresses to 0.98.
- Dark desktop adds a 600px mouse-following radial spotlight.
- Dark desktop may add a subtle border spotlight and animated border beam.
- Light mode uses diffuse shadow rather than neon glow.

Do not add Spotlight to every tiny control. Reserve it for primary cards and Bento tiles.

### 7.3 Bento grid

Canonical grid:

```tsx
<div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4 auto-rows-[minmax(60px,auto)]">
```

Use 1–4 column spans and 1–3 row spans. Let meaningful widgets occupy more space; ordinary bookmarks stay at 1×1.

### 7.4 Status and energy cues

Use compact indicators:

- 8–10px status dot.
- Optional ping ring for online/loading.
- Breathing animation around 2–5 seconds.
- Success green, warning amber, danger red, informational cyan/blue.
- Avoid large banners for routine status.

## 8. Component recipes

Detailed recipes live in `references/component-recipes.md`. At minimum, preserve these patterns:

- Hero time + date + optional lunar badge + weather + editorial greeting + Spotlight search trigger.
- Section heading with icon, optional breathing dot, title, count, and right-aligned mode control.
- Bookmark cards with compact, standard, and comfortable views.
- Colored category icon wells using `categoryColor + 20` alpha.
- Small semantic tag pills generated from a stable name hash.
- Desktop draggable/collapsible Dock and mobile bottom Dock with an energy orb.
- Admin sidebar with a translucent energy band and a shared-layout active capsule.
- Centered modal with a dimmed backdrop, fixed header/footer, and independently scrolling body.
- Responsive data management: desktop table, mobile card rows.

## 9. Motion language

Use motion to communicate state and hierarchy.

### 9.1 Preferred values

- Standard easing: `cubic-bezier(0.4, 0, 0.2, 1)`.
- Premium entrance easing: `cubic-bezier(0.22, 1, 0.36, 1)`.
- Card hover: 300–500ms.
- Page/section entrance: 400–800ms.
- Modal spring: stiffness around 300, damping around 25.
- Dock expansion spring: stiffness 300–400, damping 25–28.
- Active navigation capsule: stiffness around 180, damping around 35.
- Stagger: 40–100ms, capped after roughly 12 items.
- Theme circle reveal: 600ms.

### 9.2 Motion principles

- Motion should feel viscous and weighted.
- Prefer opacity + small Y translation.
- Use scale sparingly.
- Use shared-layout motion for active tabs and navigation capsules.
- Long ambient animation should be slow and low contrast.
- Disable decorative motion in lite mode.
- Respect `prefers-reduced-motion`.

## 10. Responsive behavior

### Desktop, 768px and above

- Full Bento density.
- Spotlight and border-beam effects allowed.
- Draggable/collapsible floating Dock.
- Persistent admin sidebar.
- Hover-revealed secondary actions.

### Mobile, below 768px

- Reduce root type scale when needed.
- Convert side navigation to overlay/drawer.
- Convert tables to stacked cards.
- Use a fixed bottom bar with `env(safe-area-inset-bottom)`.
- Use an energy-orb button to open the menu vertically above it.
- Keep tap targets at least 40–44px.
- Always show essential row actions; do not rely on hover.
- Reduce blur, animation count, and continuously moving effects.

### Card modes

- Compact: `grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3`; horizontal card internals; about 64px minimum height.
- Standard: `grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4`; vertical card internals; about 120px minimum height.
- Comfortable: `grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5`; more description space; about 140px minimum height.

## 11. Forms and modal rules

Inputs:

- 12px radius.
- `px-4 py-3`.
- Glass or tertiary background.
- Quiet border at rest, clearer border and ring on focus.
- Labels are small and secondary.
- Loading indicators sit inside the right edge.
- Optional sections expand with height + opacity animation.

Modal shell:

```tsx
className="fixed z-[100] inset-0 m-auto w-full max-w-lg h-[min(85vh,720px)] flex flex-col overflow-hidden rounded-2xl border shadow-2xl"
```

Backdrop:

```tsx
className="fixed inset-0 z-[99] bg-black/50 backdrop-blur-sm"
```

Modal motion:

- Enter: opacity 0 → 1, scale 0.95 → 1.
- Exit: reverse.
- Validation failure may use a restrained horizontal shake.
- Header and footer are fixed; body scrolls.

## 12. Admin UI rules

The admin area must remain part of the same product family.

- Desktop sidebar width: around 256px.
- Sidebar background: dark translucent band with strong blur.
- Active item: glass capsule, ghost border, slim energy bar, soft radial glow.
- Navigation icons and labels use magnetic hover only on capable desktop devices.
- Content panels use the same semantic surfaces as home cards.
- Toolbar controls use grouped capsules rather than unrelated buttons.
- Data tables use quiet separators and hover fills.
- Bulk actions appear only when selection is active.
- Mobile rows become cards with visible actions.

## 13. Accessibility and quality gates

Required:

- Semantic buttons and links.
- `aria-label` for icon-only controls.
- `aria-expanded` for expandable navigation.
- Keyboard-operable modal, menu, search, and tabs.
- Visible focus ring; never rely only on browser outline removal.
- Text contrast remains readable over wallpaper and glass.
- Truncation includes a title/tooltip when full content matters.
- Motion respects reduced-motion preference.
- Touch interaction does not depend on hover.
- Mobile bottom controls account for the device safe area.

## 14. Performance gates

- Use `requestAnimationFrame` to throttle pointer-driven visual updates.
- Pass pointer coordinates through CSS variables instead of React state when possible.
- Clean up RAF, intervals, observers, and event listeners.
- Use `will-change` only on elements that actually animate.
- Stop adding stagger delay after the first visible group.
- Avoid large blurred animated layers on mobile.
- Provide a lightweight card path without Framer Motion or Spotlight.
- Use skeletons matching the final card geometry.

## 15. Anti-patterns

Do not:

- Turn every surface into high-opacity frosted glass.
- Use neon borders in light mode.
- Use heavy shadow and heavy glow simultaneously.
- Mix unrelated radii across the same hierarchy.
- Create a rainbow palette without semantic purpose.
- Make every element float, pulse, shimmer, and rotate.
- Use pure `#000` and `#fff` as the only dark/light backgrounds.
- Replace the Bento hierarchy with a monotonous equal-card grid.
- Hide required mobile actions behind hover.
- animate hundreds of list items with growing delays.
- hard-code theme colors inside feature components when a semantic token exists.

## 16. Deliverable contract for coding agents

When implementing a NOWEN-style task, return:

1. Files changed.
2. Tokens added or reused.
3. Components added or changed.
4. Dark/light behavior.
5. Desktop/mobile behavior.
6. Motion and lite-mode behavior.
7. Accessibility checks.
8. Validation commands run.
9. Any visual deviations from this skill and why.

## 17. Acceptance checklist

A page is accepted only when:

- It looks coherent in both Deep Space and Solar Clarity.
- Main content fits the `max-w-6xl` visual rhythm unless a data-heavy page justifies more width.
- Surfaces use semantic variables.
- Card radii, padding, border, blur, and elevation follow the hierarchy.
- Desktop hover feels polished but mobile remains fully usable.
- Ambient effects do not overpower content.
- Modal content is usable at short viewport heights.
- Mobile navigation respects safe-area insets.
- Reduced-motion and lite mode remain functional.
- The result feels like NOWEN, not a generic Tailwind dashboard.

Read the supporting references before making substantial UI changes:

- `references/design-system.md`
- `references/component-recipes.md`
- `references/motion-responsive.md`
- `references/source-map.md`
