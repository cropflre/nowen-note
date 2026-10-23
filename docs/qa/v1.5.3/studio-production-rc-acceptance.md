# Nowen Studio v1.5.3 — Production Release Candidate Acceptance

> Gate owner: Release Manager. All checks must be tied to an immutable source commit. This is **not** a claim that a real desktop installer, phone or NAS has already been used.

## Tested by PR #881 — disposable actual production Docker image

Workflow: `.github/workflows/studio-production-docker-rc.yml`. Every PR run builds the final production `Dockerfile` image at the checked out commit (not a mock Hono server), exposes its service only on `127.0.0.1`, and creates a new random two-user fixture in a throwaway data mount.

Acceptance assertions (fail closed):

- `/api/health` works on a running production container; `/api/plugins/personal-apps` requires authentication.
- Two registered users are isolated: user B cannot list, read, restore, or enumerate user A's app/history.
- AI preview with no configured model fails visibly; the request does not create an app.
- AppSpec can be created, edited with CAS, stale revision conflicts, and restored to a prior historical revision without changing existing item data.
- The same image restarts from an existing SQLite volume with the original account logins, app content, owner scope and history intact.
- An online SQLite WAL-consistent backup made while production code is running passes `quick_check` and retains the expected app/version tables.
- A new, separate container can boot **only the backed-up DB copy** and pass the same authenticated persistence/ownership checks.
- Test JWTs, passwords, fixture DBs and containers are erased by shell EXIT trap. No image publishing, tagging, signing or release is attempted.

Use the CI run URL and HEAD SHA in the acceptance record. Only mark Docker CI acceptance as passed after the workflow actually finishes green.

## Manual acceptance still required — DO NOT call these passed yet

| Target | Actions / verification | Pass evidence |
|---|---|---|
| Desktop Windows EXE | Install fresh and upgrade from prior stable using a separate test profile; create, AI-edit and rollback a personal app; restart; check native SQLite data | Installer digest, version, cold-start screen and post-upgrade app revision |
| macOS x64 + arm64 | Test the unsigned candidate on matching Intel and Apple Silicon machines; separately verify signing/notarization before distribution | Host architecture, binary version and screenshots of app persistence |
| Linux desktop | Install DEB/AppImage on a real supported distribution, cold start and restart app with saved revisions | Package digest, package/runtime architecture, launch and reopen evidence |
| Docker / NAS (UGREEN / fnOS) | Mount a real persistent NAS volume and restart/upgrade; verify backup on a different location and restore from a copy. Validate file owner, volume permissions and external access | NAS model/CPU arch, image digest, volume remount, app revision after recovery |
| Android | With a clean test account, create a note, update on web, force close and reopen Android app; verify Sync V2 ACK, offline editing and account switch | Device/build version, three-device synchronization receipts, no content loss or crashes |
| AI provider | Configure a disposable API key and explicitly opt in to `backend/scripts/studio-ai-live-smoke.ts` with synthetic prompts. Test OpenAI-compatible model and intended local provider separately | Model/version, successful strict AppSpec response and redacted failure logs |

## Safe external AI provider smoke

From `backend` in a private terminal, with a temporary **test-only** credential:

```bash
STUDIO_AI_SMOKE_URL='https://your-test-provider.example/v1' \
STUDIO_AI_SMOKE_PROVIDER='openai' \
STUDIO_AI_SMOKE_MODEL='your-model' \
STUDIO_AI_SMOKE_KEY='your-private-test-key' \
node --import tsx scripts/studio-ai-live-smoke.ts
```

For Ollama/LM Studio use a reachable compatible local `/chat/completions` endpoint and `STUDIO_AI_SMOKE_PROVIDER=ollama|lmstudio` (key optional). Never put real keys in PR logs or issues.

## Release Center: correct source and final GO/NO-GO

- Source baseline for this RC is `release/v1.5.3`, currently subject to later commits. Lock a concrete 40-character SHA immediately before candidate production builds. Existing PR #872 validated a different historical candidate SHA and cannot substitute for this HEAD.
- Re-run Data Consistency Contract, V3 Foundation, Docker runtime RC and the candidate packaging workflow for **the exact same** immutable SHA; inspect artifact evidence and signatures.
- Check package digest, installer launch, upgrade from 1.5.2, rollback using a pre-upgrade backup, supported CPU architectures, local provider reachability, and tests above.
- A passed Docker test does not imply physical NAS, Android, or desktop acceptance.
- No merge to `main`, formal version tag, publishing, store submission, signing bypass or automatic rollout unless all applicable release blockers pass and a human release manager explicitly approves.
