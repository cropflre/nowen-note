# Nowen Note v1.5.4 — Production Docker Upgrade Acceptance

> Release gate: build-only QA. This workflow does not publish an image, create a tag, or deploy to a NAS.

## Automated production-container upgrade

Workflow: `.github/workflows/studio-production-docker-rc.yml`.

For the exact PR merge SHA, CI performs the following using disposable data only:

1. Check out the immutable `v1.5.3` source tag and build its real production Docker image.
2. Build the candidate `v1.5.4` production Docker image from the PR SHA.
3. Start the old image against a fresh temporary bind-mounted data directory.
4. Register synthetic users, create a personal Studio app, edit it with CAS, create history, and restore an earlier revision.
5. Stop the old container and start the v1.5.4 candidate against the **same data directory**.
6. Log in again and verify the same users, app data, ownership boundaries, and history.
7. Create a SQLite online/WAL-consistent backup from the upgraded candidate.
8. Restore that backup into a **separate** temporary data directory, run `quick_check`, start a new candidate container against the restored copy, and verify the same records.
9. Restart the upgraded container once more and verify persistence again.

The test builds both images locally on the runner; it does not pull or push a release tag. Synthetic users, credentials, containers, and temporary volumes are removed by an EXIT trap.

## Other automated coverage

- Backend full regression includes the real v1.5.0 source-to-candidate database upgrade and backup restoration against both schema versions.
- Backup/restore integrity tests verify attachment archive counts, byte counts, staging verification, mount-point-safe replacement, rollback after a failed verifier, and full-backup streaming.
- Docker amd64/arm64 builds and image runtime smoke checks are performed by the v1.5.4 release-freeze workflow.
- FPK and UPK candidates are built from the exact images produced by that workflow and retained as workflow artifacts only.

## Manual acceptance still required

| Target | Required evidence |
| --- | --- |
| Physical NAS (UGREEN / fnOS / other supported NAS) | Install FPK/UPK on a real device, verify CPU architecture, persistent volume, permissions, restart, upgrade and restore from an independent backup |
| Android | Install the QA APK on a real device, sign in through direct and reverse-proxy routes, switch account, edit offline, reconnect and verify sync acknowledgements without content loss |
| Windows | Install Full/Lite candidates, upgrade a separate test profile, verify native SQLite data and update metadata |
| macOS Intel + Apple Silicon | Launch each architecture on matching hardware; verify signature/notarization separately before distribution |
| Linux | Install AppImage/DEB on a supported distribution and verify cold start, restart and persistence |
| AI providers | Use disposable credentials and synthetic prompts; never put production API keys in CI logs |

A green Docker workflow proves the tested production image can upgrade the disposable v1.5.3 data volume and restore its generated backup. It does **not** prove physical NAS, Android, signed desktop distribution, or third-party AI provider acceptance.

## Release decision

No tag, GitHub Release, Docker registry push, app-store submission, or production deployment is authorized by this workflow. Formal publication remains restricted to:

`release-build.yml` → human candidate review → `release-publish.yml`.
