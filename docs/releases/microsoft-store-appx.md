# Microsoft Store AppX distribution (Nowen Note)

## What is implemented
- Dedicated AppX output: `electron/builder.store.config.js` to `dist-electron-store/`.
- Manually dispatched workflow: `.github/workflows/microsoft-store-appx.yml`. It **never** uploads to public GitHub Releases and does not touch existing NSIS/portable/SignPath pipelines.
- Store package runtime: Electron `process.windowsStore` on Windows, paired with `app.isPackaged`, routes updates to Microsoft Store. No `electron-updater` download/installation is attempted.
- Fixed, native-validated `ms-windows-store://downloadsandupdates` action from **Settings → About**. No arbitrary renderer-supplied URI is accepted.
- Existing GitHub Direct Windows installers, Lite channel and macOS/Linux clients keep their preexisting behavior. The Direct Windows channel currently opens the browser for manual package updates; Store publishing does not change it.

## Confirmed Microsoft Partner Center identity (2026-10-15)
The public package identity from **Nowen Note → Product management → Product identity** is now pinned in `electron/storeIdentity.js`. No Actions Variables or signing certificate required for Store submission.

| Partner Center field | Verified value |
| --- | --- |
| `Package/Identity/Name` | `Nowen.NowenNote` |
| `Package/Identity/Publisher` | `CN=74C7CC89-20E0-4BEA-AD68-6A3238278EF3` |
| `PublisherDisplayName` | `Nowen` |
| Microsoft Store Product ID | `9MZ7Z6S39LL3` |
| Internal `appx.applicationId` | `NowenNote` (stable build entry point, NOT Store Product ID) |

Identity values are *public*, unlike signing keys. Accidentally overriding identity in Actions Variables causes a validation failure rather than publishing an unrelated app. Do not change identity after Store publication or updates may fail.

`https://apps.microsoft.com/detail/9MZ7Z6S39LL3` is the **reserved Store listing URL**; it may not be publicly accessible until certification and publication.

## Build
1. AppX candidate now builds automatically in the PR when the Store code changes (or open [Microsoft Store AppX workflow](https://github.com/cropflre/nowen-note/actions/workflows/microsoft-store-appx.yml).
2. For a manual build, select the reviewed release tag or Store repair branch and click **Run workflow**. Record the resolved commit SHA with the artifact; do not reuse a package from an older version.
3. Wait for `contracts` and `store-package` jobs. Download `nowen-note-store-appx` artifact from this run.
4. Upload the verified `.appx` to your reserved Nowen Note application's Partner Center submission. Microsoft Store signs the release as part of its publication process. An unsigned local package may not install via `Add-AppxPackage`.
5. Provide store listing description, screenshots, privacy/support policy, category, age rating, availability, and certification notes. Publish only after passing Store certification.

Local test/config: `npm run test:microsoft-store`. On a Windows machine, `npm run electron:build:store` prepares the embedded runtime, backend, frontend and native modules, then invokes the independent Store builder. No GitHub Actions Variables are needed.

## Tile assets and certification resubmission
- The October 16, 2026 certification report rejected `Nowen-Note-Store-1.5.1-x64.appx` under **10.1.1.11 On Device Tiles** because it contained a default tile image.
- `build/appx/` supplies all four assets that electron-builder otherwise replaces with sample artwork: StoreLogo, Square44x44Logo, Square150x150Logo and Wide310x150Logo. Regenerate these from the existing Nowen SVG with `npm run build:icon`.
- Store contract tests exercise electron-builder's asset selection to reject sample fallback. The Windows workflow also compares each packaged asset's SHA-256 with the reviewed source asset before uploading the candidate.
- Both workflow jobs install root packaging dependencies before loading builder configuration. A local test run with preinstalled dependencies alone does not verify a clean CI checkout.
- Keep a repaired Store candidate's commit SHA separate from the original release tag. Passing these checks does not establish Microsoft certification or real-Windows acceptance.

## Mandatory real-Windows acceptance before publication
- Validate package identity, version, **full-trust execution**, launch via Start Menu, and actual Microsoft Store signing on a private Store flight. No CI test can substitute for installation.
- **Persistence**: create local SQLite notes, attachments, offline IndexedDB data, tasks, plugins, encryption secrets, and backups; quit, launch and then update from a newer Store version. Verify every item survives. The Microsoft Store package may use a different `userData` location from the NSIS install. **Do not assume automatic data migration or delete the NSIS installation first.**
- Local backend startup, embedded Electron/Node child processes, `better-sqlite3` native ABI, loopback port, NAS access, private LAN, external files, file dialogs, file associations and clipboard.
- Windows Store package's installed folder is read-only. All writes, plugin storage, logs and temporary files must use user-writable paths; never write under `process.resourcesPath` or the package install directory.
- Verify both manual menu **Check for updates** and About page's **Open Microsoft Store updates** open the Store, and never download `latest.yml`, a GitHub `.exe`, or call `quitAndInstall()`.
- Upgrade from Store vA to Store vB with identical package identity/publisher and increasing version; confirm Store-managed update with user configuration preserved.
- The Store app is a new install channel. Existing NSIS/portable installations **do not automatically migrate** into Store.
- If any packaged process, native plugin, backup or data-path behavior fails, block Store certification/publishing; fix in a separate follow-up PR.

**Release gate:** current implementation supplies an AppX submission candidate + automated contract/manifest checks. It has not been certified, Microsoft-signed, or validated on a real Store-installed Windows machine. This is **not a completed Store listing**.
