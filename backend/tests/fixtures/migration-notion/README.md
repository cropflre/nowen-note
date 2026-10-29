# Synthetic Notion migration fixtures

These files are synthetic, not a private workspace export. They model nested
Markdown pages and database CSV described by Notion's official export guide:
https://www.notion.com/help/export-your-content

The page UUID suffix and folder conventions are fixture-tested heuristics rather
than a versioned format guaranteed by that documentation. CSV values remain
source metadata; the adapter does not claim to recreate database views, formulas,
relations, comments, history, or permissions.
