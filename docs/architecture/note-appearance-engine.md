# Note Appearance Compatibility Layer

> Deprecated for new product work. See `docs/architecture/app-appearance-style.md`.

Earlier `release/v1.5.0` iterations experimented with account-level and per-note appearance themes.
The product direction is now **whole-application appearance styles**, not a second theme system scoped
to note content.

Current compatibility policy:

- do not expose “默认笔记主题 / 笔记外观风格” in Settings;
- do not expose per-note appearance override controls in the editor;
- keep existing note appearance metadata/API temporarily so old databases remain readable;
- do not add new themes, UI or plugin extension points to this legacy capability;
- prevent old cached note-theme tokens from overriding the selected App Appearance Style;
- all new visual styles belong to `frontend/src/lib/appAppearance.ts`.

The active architecture is:

```text
App Appearance Style Registry
→ Light/Dark Resolver
→ Global semantic design tokens
→ entire Nowen Note application
```
