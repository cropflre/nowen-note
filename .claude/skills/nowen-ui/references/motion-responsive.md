# NOWEN Motion, Responsive, and Performance Reference

## 1. Motion hierarchy

### Level A — functional

Always allowed unless reduced motion is enabled:

- Modal open/close.
- Drawer open/close.
- Active tab/capsule movement.
- Accordion height transition.
- Drag feedback.
- Button press.

### Level B — polish

Desktop/full mode:

- Card lift.
- Spotlight fade.
- Border beam.
- Staggered item entrance.
- Dock magnification or energy breathing.

### Level C — atmosphere

Full mode only:

- Floating blurred orbs.
- Aurora breathing.
- Meteors.
- Background beams.
- Long-running scan lines and glow pulses.

Lite mode should preserve Level A, simplify Level B, and disable most Level C.

## 2. Motion presets

```ts
export const nowenMotion = {
  standardEase: [0.4, 0, 0.2, 1],
  premiumEase: [0.22, 1, 0.36, 1],
  modal: { type: 'spring', stiffness: 300, damping: 25 },
  dock: { type: 'spring', stiffness: 350, damping: 25 },
  liquidCapsule: { type: 'spring', stiffness: 180, damping: 35 },
  magneticAttract: { type: 'spring', stiffness: 200, damping: 25 },
  magneticRelease: { type: 'spring', stiffness: 120, damping: 12, mass: 1.2 },
}
```

## 3. Entry patterns

### Hero

- Container: opacity 0 + y 30 → visible over 800ms.
- Time: opacity 0 + scale 0.9, delayed 200ms.
- Greeting: opacity only, delayed 400ms.
- Search: opacity 0 + y 20, delayed 600ms.

Lite mode:

- Hero y offset around 10px.
- Duration around 500ms.
- No Sparkles.

### Grid items

- opacity 0 + y 20 → visible over 400ms.
- Delay per item 40–50ms.
- Stop increasing delay after about twelve items.

### Modal

- opacity + scale.
- Optional validation shake: 0, -10, 10, -10, 10, 0 over about 400ms.

## 4. Hover patterns

- Primary card: y -4px.
- Heavy dashboard card: y -2px.
- Search trigger: y -2px.
- Icon button: scale 1.05–1.1 only when it remains stable in layout.
- Press: scale 0.98 or 0.95.

Never combine a large translation, large scale, glow, and rotation on one routine hover.

## 5. Ambient timing

- Theme/Aurora breathing: 8–10 seconds.
- Floating orbs: 12–20 seconds.
- Energy ring: 2–3 seconds.
- Sidebar breathing: about 5 seconds.
- Shimmer: 1.5–2 seconds.
- Border beam: 8–12 seconds.
- Meteor: about 5 seconds with sparse count.

## 6. Pointer-driven effects

Use CSS variables:

```ts
const raf = useRef(0)

function onPointerMove(event: React.PointerEvent<HTMLElement>) {
  cancelAnimationFrame(raf.current)
  raf.current = requestAnimationFrame(() => {
    const element = event.currentTarget
    const rect = element.getBoundingClientRect()
    element.style.setProperty('--spotlight-x', `${event.clientX - rect.left}px`)
    element.style.setProperty('--spotlight-y', `${event.clientY - rect.top}px`)
  })
}
```

Do not update pointer coordinates through React state on every event.

## 7. Breakpoint behavior

| Width | Behavior |
|---|---|
| `<640px` | Root type may reduce to 14px; one-column comfortable layout; mobile cards and bottom Dock |
| `640–767px` | Two or three bookmark columns depending on mode |
| `768–1023px` | Desktop behaviors begin; four-column Bento base; persistent admin sidebar |
| `1024–1279px` | Six-column Bento; standard bookmarks often four columns |
| `≥1280px` | Compact bookmarks may use six columns; content remains centered |

## 8. Mobile performance policy

Disable or simplify:

- Mouse-following Aurora.
- Multiple 500–700px blurred orbs.
- Continuous border beams on every card.
- Complex Dock magnification.
- Hover-only interactions.
- Large stagger sequences.

Keep:

- Theme gradient.
- Clear glass surfaces.
- Short drawer/menu transitions.
- Tap feedback.
- Safe-area-aware bottom navigation.
- One active energy indicator.

## 9. Reduced motion

Add a global policy:

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    scroll-behavior: auto !important;
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
```

In JavaScript animation libraries, read the preference and skip large transforms or ambient loops.

## 10. Theme transition

The original visual language uses a circular reveal from the interaction origin:

```css
@keyframes nowen-theme-reveal {
  from { clip-path: circle(0% at var(--origin-x, 50%) var(--origin-y, 50%)); }
  to { clip-path: circle(150% at var(--origin-x, 50%) var(--origin-y, 50%)); }
}
```

Duration: around 600ms with standard easing.

Fallback: simple background and color transition over 400–500ms.

## 11. Safe area

Every fixed mobile bottom surface must use:

```css
padding-bottom: max(8px, env(safe-area-inset-bottom));
```

Also ensure page content has enough bottom padding to remain scrollable above the Dock.

## 12. Z-index map

Recommended layers:

- Base atmosphere: `0` or negative local layer.
- Content: `10`.
- Sidebar/Dock: `40–80`.
- Menu backdrop: `70`.
- Mobile menu items: `80`.
- Modal backdrop: `99`.
- Modal: `100`.
- Toast/tooltips: `110+`.
- Noise texture: only use an extremely high layer when it is pointer-events none.

Avoid creating unnecessary stacking contexts around fixed overlays.

## 13. Validation matrix

Test at minimum:

- 390×844 mobile light.
- 390×844 mobile dark.
- 768×1024 tablet.
- 1440×900 desktop light.
- 1440×900 desktop dark.
- Short viewport height around 600px with modal open.
- Wallpaper enabled.
- Lite mode enabled.
- Reduced motion enabled.
- Keyboard-only navigation.
