# Large Markdown editor freeze fixture

This directory contains a privacy-safe reproducer for a real Markdown note that caused
the nowen-note editor to freeze during local development.

## Original sample profile

- Size: `2,412,624` bytes
- Characters: about `1.93M`
- Lines: `45,939`
- Markdown code-fence markers: `490`
- Headings: `1,089`
- Tool-call sections: `1,793`
- HTML-like tags: about `7,537`
- Longest line: `20,166` characters

The original export was **not committed** because it contained a JWT inside a copied
WebSocket error log. The generator below recreates the same stress profile without
personal content, access tokens, or account identifiers.

## Generate the fixture

From the repository root:

```bash
node scripts/generate-large-markdown-fixture.mjs
```

Default output:

```text
tmp/fixtures/history_202605071054.generated.md
```

A custom path can be supplied:

```bash
node scripts/generate-large-markdown-fixture.mjs ./tmp/large-note.md
```

## Manual reproduction

1. Generate the file.
2. Import it as a Markdown note.
3. Open it in source, preview, and split modes.
4. Switch between notes, scroll rapidly, and edit around large tool-call blocks.
5. Record:
   - time until the editor becomes interactive;
   - main-thread long tasks;
   - memory growth;
   - keystroke latency;
   - whether closing or switching the note recovers the UI.

## Expected behavior

- Import and open should not permanently block the renderer.
- The app should show progress or a large-document fallback before expensive parsing.
- Editing should remain responsive, or the note should open in a degraded/virtualized mode.
- Switching away from the note should promptly release expensive editor work.

## Notes

This fixture is intentionally generated instead of checked in as a 2.4 MB Markdown blob,
so the repository remains small and the sample cannot accidentally preserve credentials.
