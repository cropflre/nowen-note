# Phase D1 — reuse attachments in notes

Baseline: `release/v1.5.2` at `e5c6e4efe2d0f5b1e9d5d9daa4fc58ef95cbe951`.

Existing detail references, Markdown snippets, rich-text nodes and the normal save/reference index are reused.
The picker now uses the target note's space, paginates beyond fifty files and checks server authorization again before insertion.
The preflight requires an editable active target, downloadable source, identical space and source reshare permission for note attachments.
It does not write a reference ahead of the editor save or copy any file. Native owned personal files use the local authority and persist their portable attachment URL.
Failed authorization keeps the picker available for retry. Delayed responses are ignored after note/space/account/server changes.
Markdown insertion anchors follow intervening text edits; switching notes closes both editors' pickers.

Executed: backend linking 5 tests; existing asset safety 6 tests; picker/snippet/Native scope 12 frontend tests; backend and frontend TypeScript; changed picker ESLint; frontend production build (existing chunk warnings remain).
DCC-006 applies to target scope checks; DCC-007 applies to retaining indexed references until actual note editing removes them.
Yjs persistence and subdocument saves now update the reference index inside the content transaction. A regression injects an index failure, verifies rollback and retries without losing the Yjs edit. Missing legacy attachment IDs remain tolerated; other reference-storage errors propagate for rollback.
No database migration or Sync V2 protocol change.
Real application screenshots and consolidated phase acceptance are recorded separately after the reliability modules are integrated.
No installed Electron, Android device or production object-storage acceptance is claimed.
