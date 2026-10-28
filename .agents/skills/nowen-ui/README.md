# NOWEN UI Skill

A portable UI design-and-implementation skill distilled from the whole-site design language of `cropflre/NOWEN` at commit `c2e0a631e2d78a1dfe0e81ff32a81e259631fe16`.

## Included

- `SKILL.md` — primary agent instructions.
- `references/design-system.md` — tokens, typography, palette, spacing, surfaces.
- `references/component-recipes.md` — practical UI component patterns.
- `references/motion-responsive.md` — motion, mobile, lite mode, performance.
- `references/source-map.md` — audited repository sources.
- `assets/nowen-ui-tokens.css` — portable dark/light token starter.
- `examples/NowenCard.tsx` — Spotlight card starter component.

## Use

Place the `nowen-ui-skill` directory in the skills directory supported by your coding agent, or attach the folder and instruct the agent to read `SKILL.md` before changing UI code.

Example invocation:

```text
Use the NOWEN UI skill to redesign this page.
Preserve the existing framework and business logic.
Implement dark/light themes, semantic tokens, responsive behavior,
lite-mode fallback, and the acceptance checklist in SKILL.md.
```

## Scope

This package extracts visual and interaction rules. It does not include NOWEN business logic, APIs, database code, or private data.
