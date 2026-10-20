# NOWEN Component Recipes

These are implementation recipes, not rigid copies. Preserve the hierarchy, geometry, and behavior while adapting labels and data.

## 1. Page shell

```tsx
export function NowenPageShell({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-screen px-4 sm:px-6 lg:px-8 pb-32">
      <div className="max-w-6xl mx-auto">{children}</div>
    </main>
  )
}
```

For admin tables or charts, `max-w-7xl` is acceptable when the content genuinely needs width.

## 2. Hero section

Structure:

1. Time.
2. Date and optional badge.
3. Optional weather.
4. Editorial greeting or rotating wisdom.
5. Search trigger.

```tsx
<section className="pt-20 pb-16 text-center relative">
  <div className="mb-8">
    <div className="text-3xl sm:text-4xl lg:text-5xl font-semibold tracking-tighter font-mono text-[var(--color-text-primary)]">
      09:41
    </div>
    <div className="mt-3 flex flex-wrap items-center justify-center gap-2 text-base uppercase tracking-[0.2em] text-[var(--color-text-muted)]">
      <span>Friday, July 10</span>
      <span className="px-2 py-0.5 rounded-md text-sm normal-case tracking-normal bg-[var(--color-bg-tertiary)]">六月廿六</span>
    </div>
  </div>

  <h1 className="min-h-[3.5em] mb-8 flex items-center justify-center text-base sm:text-lg lg:text-xl font-serif font-medium tracking-wide text-[var(--color-text-secondary)]">
    Make the interface quiet enough for ideas to arrive.
  </h1>

  <SearchTrigger />
</section>
```

## 3. Search trigger

The search trigger is not a full-width input. It is an inviting command capsule.

```tsx
<button className="inline-flex items-center gap-3 px-6 py-3.5 rounded-xl border bg-[var(--color-glass)] border-[var(--color-glass-border)] transition-all hover:-translate-y-0.5">
  <Search className="w-4 h-4 text-[var(--color-text-muted)]" />
  <span className="tracking-wide text-[var(--color-text-muted)]">Search bookmarks</span>
  <kbd className="ml-2 px-2 py-1 rounded text-xs flex items-center gap-1 bg-[var(--color-bg-tertiary)] border border-[var(--color-border-light)] text-[var(--color-text-muted)]">
    ⌘ K
  </kbd>
</button>
```

Full mode can add a slow moving border with a 3-second duration. Lite mode should use a static border.

## 4. Section heading

```tsx
<div className="flex items-center gap-3 mb-6">
  <div className="relative">
    <Pin className="w-5 h-5 text-yellow-400" />
    <span className="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-yellow-400 animate-pulse" />
  </div>
  <h2 className="text-xl font-medium tracking-wide text-[var(--color-text-primary)]">Favorites</h2>
  <span className="text-sm text-[var(--color-text-muted)]">12</span>
  <div className="ml-auto">...</div>
</div>
```

The right side may hold a view mode or widget size capsule.

## 5. Bento grid

```tsx
<div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4 auto-rows-[minmax(60px,auto)]">
  <div className="md:col-span-2 row-span-2">Large widget</div>
  <div className="col-span-1 row-span-1">Bookmark</div>
</div>
```

Span rules:

- Ordinary bookmark: 1×1.
- Small monitor: 2×1.
- Detailed monitor: 2×2.
- Hero widget: 3–4 columns only when the content justifies it.

## 6. Spotlight card primitive

```tsx
function SpotlightCard({ children, interactive = true }: Props) {
  return (
    <div
      className={cn(
        "group relative overflow-hidden rounded-2xl p-5 backdrop-blur-xl",
        "border border-[var(--color-glass-border)] bg-[var(--color-glass)]",
        "transition-all duration-500",
        interactive && "cursor-pointer hover:-translate-y-1 active:scale-[0.98]"
      )}
      style={{ boxShadow: "var(--color-shadow)" }}
    >
      <div className="pointer-events-none absolute -inset-px hidden rounded-2xl opacity-0 transition-opacity duration-300 dark:block group-hover:opacity-100 spotlight-layer" />
      <div className="relative z-10">{children}</div>
    </div>
  )
}
```

Suggested CSS:

```css
.spotlight-layer {
  background: radial-gradient(
    600px circle at var(--spotlight-x, 50%) var(--spotlight-y, 50%),
    rgba(102, 126, 234, 0.15),
    transparent 40%
  );
}
```

Update `--spotlight-x` and `--spotlight-y` with a RAF-throttled pointer handler.

## 7. Bookmark card

### Standard/comfortable

```tsx
<div className="relative flex h-full flex-col">
  <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-xl bg-[var(--color-bg-tertiary)]">
    <Icon className="h-5 w-5 text-[var(--color-primary)]" />
  </div>
  <h3 className="mb-1 line-clamp-1 font-medium text-[var(--color-text-primary)]">Title</h3>
  <p className="line-clamp-2 flex-1 text-sm text-[var(--color-text-muted)]">Description or hostname</p>
  <TagRow />
</div>
```

### Compact

```tsx
<div className="relative flex h-full flex-row items-center gap-3">
  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-[var(--color-bg-tertiary)]">...</div>
  <div className="min-w-0 flex-1">
    <h3 className="line-clamp-1 text-sm font-medium text-[var(--color-text-primary)]">Title</h3>
    <p className="line-clamp-1 text-xs text-[var(--color-text-muted)]">Description</p>
  </div>
</div>
```

Private items use a small amber lock badge at the top-right, not a large banner.

## 8. View mode capsule

```tsx
<div className="flex items-center gap-0.5 rounded-lg p-0.5 bg-[var(--color-bg-tertiary)]">
  {modes.map(({ id, Icon }) => (
    <button
      className="rounded-md p-1.5 transition-all"
      style={{
        background: active === id ? "var(--color-glass)" : "transparent",
        color: active === id ? "var(--color-text-primary)" : "var(--color-text-muted)",
      }}
    >
      <Icon className="h-3.5 w-3.5" />
    </button>
  ))}
</div>
```

Use the same pattern for S/M/L widget sizing.

## 9. Desktop Dock

Two states:

### Collapsed energy orb

- 48×48px circle.
- Dark: black 70%, white border 15%, cyan icon and soft cyan glow.
- Light: white 90%, slate border, blue icon and soft neutral shadow.
- Slow breathing ring on desktop.
- Click expands; drag repositions.

### Expanded Dock

- Glass capsule, 24px blur, 12px radius.
- Compact 40px item rhythm.
- Magnification may follow pointer proximity.
- A small handle collapses the Dock.
- Position persists in local storage.
- Keep the Dock within a 16px viewport margin.

## 10. Mobile Dock

Bottom bar:

```tsx
<div
  className="fixed bottom-0 left-0 right-0 z-[75] flex items-center px-3 py-2 bg-white/90 dark:bg-black/80 backdrop-blur-xl border-t border-slate-200/60 dark:border-white/10"
  style={{ paddingBottom: "max(8px, env(safe-area-inset-bottom))" }}
>
```

Menu behavior:

- Energy orb is 44×44px.
- Tapping opens a dimmed, lightly blurred backdrop.
- Items expand vertically above the orb.
- Item cards are 16px radius with a 40px icon well.
- Optional submenus push into a second level with a clear back control.
- Use 5–10ms haptic feedback where supported.

## 11. Admin sidebar

Desktop:

- 256px width, full height.
- Translucent black energy band with `backdrop-blur-xl`.
- Active item uses a shared-layout 12px capsule.
- Capsule contains a ghost border, top highlight line, left energy bar, and radial glow.
- Icon, label, and count badge remain above the active capsule.
- Optional magnetic hover offsets are only 2–3px.

Mobile:

- Replace persistent sidebar with a menu button and overlay drawer.
- Close the drawer immediately after navigation.

## 12. Admin table and mobile card rows

Desktop table row:

```tsx
<div className="hidden sm:grid grid-cols-[auto_auto_1fr_auto_auto_auto] gap-4 items-center px-5 py-3 hover:bg-[var(--color-glass-hover)]">
```

Mobile row:

```tsx
<div className="sm:hidden flex items-center gap-3 p-3">
```

Rules:

- Checkbox is 20×20px.
- Category icon well is 32×32px.
- Secondary actions may fade in on desktop hover.
- On mobile, essential edit/delete actions are always visible.
- Selection uses a low-alpha primary fill.

## 13. Modal

```tsx
<AnimatePresence>
  {open && (
    <>
      <motion.div className="fixed inset-0 z-[99] bg-black/50 backdrop-blur-sm" />
      <motion.section
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95 }}
        transition={{ type: "spring", damping: 25, stiffness: 300 }}
        className="fixed z-[100] inset-0 m-auto w-full max-w-lg h-[min(85vh,720px)] flex flex-col overflow-hidden rounded-2xl border shadow-2xl bg-[var(--color-bg-secondary)] border-[var(--color-glass-border)]"
      >
        <header className="shrink-0 flex items-center justify-between px-6 py-4 border-b border-[var(--color-border)]">...</header>
        <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5 space-y-5">...</div>
        <footer className="shrink-0 px-6 py-4 border-t border-[var(--color-border)]">...</footer>
      </motion.section>
    </>
  )}
</AnimatePresence>
```

## 14. Inputs

```tsx
<input className="w-full rounded-xl px-4 py-3 bg-[var(--color-glass)] border border-[var(--color-glass-border)] text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] transition focus:border-[var(--color-primary)] focus:ring-4 focus:ring-[var(--color-glow)]" />
```

Do not use dark-only `border-white/10` in a reusable primitive. Map borders to semantic tokens.

## 15. AI action

Use a restrained purple-to-cyan energy treatment:

- Low-alpha gradient background.
- Thin purple border.
- Gradient text or icon.
- Progress state rotates Sparkles slowly.
- Success switches to emerald.
- Do not use a full saturated gradient button unless it is the primary CTA.

## 16. Skeletons

Skeleton geometry must match final cards:

- Same radius.
- Same padding.
- Icon block matches 32 or 40px.
- Title line around 75% width.
- Description line around 50% width.
- Theme-aware shimmer using border-light → border → border-light.
