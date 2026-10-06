# Code signing policy

Free code signing provided by SignPath.io, certificate by SignPath Foundation.

## Project and roles

- Project: **Nowen Note**
- Source repository: `https://github.com/cropflre/nowen-note`
- Authors: [cropflre](https://github.com/cropflre)
- Reviewers: [cropflre](https://github.com/cropflre)
- Approvers: [cropflre](https://github.com/cropflre)

Only release artifacts built by GitHub Actions from committed source code in this repository may be submitted for SignPath Foundation signing. Local unsigned Windows Full/Lite packages must not become formal GitHub Release assets.

Code signing processes build artifacts only and do not send user notes, attachments, accounts, tokens, AI conversations, or self-hosted service data to SignPath.

## Formal Windows release boundary

`electron-builder --publish never` → GitHub Actions artifact → SignPath → Authenticode/CN verification → rebuild `.blockmap` and `latest*.yml` integrity fields → updater validation → Draft GitHub Release → remote validation → publish.

Full and Lite use separate SignPath Artifact Configurations:

- `.signpath/artifact-configurations/windows-full.xml`
- `.signpath/artifact-configurations/windows-lite.xml`

Both configurations restrict signing to the exact top-level setup/portable executables and require the package version parameter.

## Required GitHub Actions configuration

Repository Secret:

- `SIGNPATH_API_TOKEN`

Repository Variables used by production signing:

- `SIGNPATH_FULL_ARTIFACT_CONFIGURATION_SLUG`
- `SIGNPATH_LITE_ARTIFACT_CONFIGURATION_SLUG`

Optional overrides (the repository has safe defaults for the currently approved SignPath organization/project/policy):

- `SIGNPATH_ORGANIZATION_ID`
- `SIGNPATH_PROJECT_SLUG`
- `SIGNPATH_SIGNING_POLICY_SLUG`

`NOWEN_WINDOWS_PUBLISHER_NAME` must be copied from the real `SignerCertificate` common name of the first approved SignPath release-signed candidate. Do not guess it.
It is required for formal artifact verification and publication, but not for the first production signing request. Bootstrap accepts only the `release-signing` policy and valid Full/Lite signatures with the same CN; it never uses a test certificate.

## First signed bridge release

Existing Windows installations that were unsigned or used a different publisher identity should not be expected to silently cross the publisher boundary through the in-app updater.

For the first SignPath-signed bridge release:

1. Build and sign a candidate through GitHub Actions + SignPath.
2. When the publisher variable is absent, the tag workflow reads the returned artifacts using `Get-AuthenticodeSignature`, validates Full/Lite signatures, and prints the detected common name/thumbprints. It deliberately fails before metadata refresh or formal artifact upload; any Release must remain Draft.
3. Set the GitHub Repository Variable `NOWEN_WINDOWS_PUBLISHER_NAME` to that exact common name. Rerun the entire Windows build/signing job (not just the failed verification step), so both installers embed the confirmed updater publisher identity.
4. Require an exact CN match on every signed executable and publish only after signed updater metadata validation passes. Never publish bootstrap candidates or substitute a test-signing CN.
5. Ask existing Windows users to manually install this bridge release.
6. Publish a second version with the same signer identity and verify in-app update from the bridge release.
