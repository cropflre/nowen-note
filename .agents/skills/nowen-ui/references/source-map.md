# Extraction Source Map

Repository: `cropflre/NOWEN`\
Branch: `main`\
Commit: `c2e0a631e2d78a1dfe0e81ff32a81e259631fe16`\
Release message: `chore(release): v0.1.4`

This skill was distilled from the following source areas.

| Source | Extracted concepts |
|---|---|
| `src/index.css` | Global fonts, default tokens, dark/light behavior, glass, theme cards, vibe cards, Spotlight, glow, animations, skeletons, scrollbars, noise, responsive root sizing |
| `tailwind.config.js` | Semantic Tailwind mapping, font families, shadow/glow utilities, animation/keyframe vocabulary |
| `src/hooks/useTheme.tsx` | Sixteen theme palettes, token application, dark/light root classes, automatic theme behavior, circular transition |
| `src/App.tsx` | Page shell, max width, section spacing, Bento composition, card view modes, mobile/desktop Dock split, wallpaper layers, private access screen |
| `src/components/home/HeroSection.tsx` | Hero type scale, time/date hierarchy, editorial greeting, wallpaper text shadows, entry timing |
| `src/components/home/SearchHint.tsx` | Search command capsule, moving border, keyboard badge, lite-mode fallback |
| `src/components/ui/bento-grid.tsx` | Six-column responsive Bento geometry and span behavior |
| `src/components/ui/spotlight-card.tsx` | Card geometry, pointer-tracked Spotlight, border beam, hover/tap behavior, lightweight mode |
| `src/components/ui/aurora-background.tsx` | Deep Space and Solar Aurora layers, pointer-following background, ambient orb animation, mobile reductions |
| `src/components/ui/floating-dock.tsx` | Draggable/collapsible desktop Dock, energy orb, persistence, viewport clamping |
| `src/components/ui/mobile-floating-dock.tsx` | Safe-area bottom bar, vertical flower menu, backdrop, submenu, haptics |
| `src/components/admin/AdminSidebar.tsx` | Energy-band sidebar, liquid active capsule, magnetic hover, accessibility shadows, mobile navigation strategy |
| `src/pages/Admin.tsx` | Responsive tables/cards, grouped controls, selection and drag patterns |
| `src/components/AddBookmarkModal.tsx` | Modal shell, scrolling body, input geometry, AI action states, collapsible form sections |
| `src/components/SystemMonitorCard.tsx` | Technical typography, state colors, telemetry animation, scan lines, data visualization energy cues |
| `README.md` | Product positioning and screenshot coverage across desktop, mobile, admin, dark, and light modes |

## Extraction boundary

This package intentionally extracts the **design language and implementation rules**, not the product's business logic, API behavior, database model, or content.

## Recommended update process

When the source repository receives a major UI revision:

1. Compare `src/index.css`, `src/hooks/useTheme.tsx`, and the core UI primitives against this package.
2. Update semantic tokens first.
3. Update component recipes only when geometry or interaction patterns changed.
4. Record the new source commit in `SKILL.md` and this file.
