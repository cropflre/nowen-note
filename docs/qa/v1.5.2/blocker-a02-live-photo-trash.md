# A02 Live Photo / recycle-bin regression

Base: e249719c. New HTTP regressions fail before the fix with available instead of missing-companion, both for a newly analyzed photo and an existing pair/MP4 cache.

New pairing, lazy pairing and post-read checks require active source and companion records in the same note/account/workspace. Soft deletion retains recovery bytes; cached MP4 and original-motion reads cannot bypass trash. Restoration permits pairing again without reviving old public links. Confirmed purge clears dependent variant rows and derived caches while retaining the active photo. Download-denied and unsigned requests remain denied.

Validation: 21 tests passed across attachment-modern-media, attachment-trash and attachment-file-share; backend TypeScript and production bundle passed. The existing motion-cache deletion assertion now checks retention on soft deletion and cleanup on explicitly confirmed purge. No safety assertion was removed.

Commands (backend):

```sh
node --import tsx --import ./tests/setup-db-isolation.ts --test --test-concurrency=1 tests/attachment-modern-media.test.ts tests/attachment-trash.test.ts tests/attachment-file-share.test.ts
npm run build:tsc -- --noEmit
npm run build
```

Local macOS / Node 24.18.0 evidence only. Production object storage and installed mobile clients remain unverified; this does not authorize release.
