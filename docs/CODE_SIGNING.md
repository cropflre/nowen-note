# Code signing policy

Free code signing provided by SignPath.io, certificate by SignPath Foundation.

## Project and roles

- Project: **Nowen Note**
- Source repository: `https://github.com/cropflre/nowen-note`
- Authors: [cropflre](https://github.com/cropflre)
- Reviewers: [cropflre](https://github.com/cropflre)
- Approvers: [cropflre](https://github.com/cropflre)

Only release artifacts built by GitHub Actions from committed source code in this repository may be submitted for SignPath Foundation signing. Local unsigned Windows Full/Lite packages must not be uploaded as formal GitHub Release assets.

Privacy and third-party data handling are described in [PRIVACY.md](./PRIVACY.md). Code signing processes build artifacts only and does not send user notes, attachments, accounts, tokens, AI conversations, or self-hosted service data to SignPath.

## Formal Windows release boundary

The formal Windows release flow is:

`electron-builder --publish never` → GitHub Actions artifact → SignPath → Authenticode verification → rebuild `.blockmap` and `latest*.yml` integrity fields → local updater validation → draft GitHub Release → remote updater validation → publish Release.

The Full and Lite editions use separate SignPath Artifact Configurations so the expected PE product metadata can be enforced independently.

## SignPath Artifact Configurations

Create two Artifact Configurations in the SignPath project using these repository templates:

- Full: [`.signpath/artifact-configurations/windows-full.xml`](../.signpath/artifact-configurations/windows-full.xml)
- Lite: [`.signpath/artifact-configurations/windows-lite.xml`](../.signpath/artifact-configurations/windows-lite.xml)

Both configurations use a ZIP root because GitHub `actions/upload-artifact` stores the submitted artifact as a ZIP. They require the build `version` parameter and restrict the signed PE files to the exact stable installer/portable names, product name, and product version for that edition.

Do not broaden these templates to `*.exe` or sign third-party binaries from packaged application internals. Only the two top-level Nowen Note executables in each submitted artifact are intended to receive the SignPath Foundation signature.

## Required GitHub Actions configuration

Repository Secret:

- `SIGNPATH_API_TOKEN`

Repository Variables:

- `SIGNPATH_ORGANIZATION_ID`
- `SIGNPATH_PROJECT_SLUG`
- `SIGNPATH_SIGNING_POLICY_SLUG`
- `SIGNPATH_FULL_ARTIFACT_CONFIGURATION_SLUG`
- `SIGNPATH_LITE_ARTIFACT_CONFIGURATION_SLUG`
- `NOWEN_WINDOWS_PUBLISHER_NAME`

`NOWEN_WINDOWS_PUBLISHER_NAME` must be copied from the actual `SignerCertificate` common name of the first approved SignPath-signed candidate. Do not guess this value.

## First signed bridge release

Existing Windows installations that were unsigned or used a different publisher identity should not be expected to silently cross the publisher boundary through the in-app updater.

For the first SignPath-signed bridge release:

1. Build and sign a new candidate through GitHub Actions + SignPath.
2. Confirm `Get-AuthenticodeSignature` reports `Valid`, and record the signer common name and thumbprint.
3. Set `NOWEN_WINDOWS_PUBLISHER_NAME` to the exact signer common name.
4. Publish only after local and remote updater metadata validation passes.
5. Ask existing Windows users to manually install this bridge release from GitHub Releases.
6. Publish a second version with the same signer identity and verify in-app update from the bridge release on a clean Windows machine.

## SignPath Foundation application readiness

Before requesting production signing, verify:

- The project is already released and actively maintained.
- The repository and distributed code are under an OSI-approved open-source license without proprietary project components.
- GitHub account access used by maintainers has multi-factor authentication enabled.
- The project home page and GitHub Release pages expose or link this **Code signing policy**.
- The privacy policy covers network connections and user-configured third-party services.
- The signing request requires manual approval.
- SignPath is linked to GitHub.com as the trusted build system for the project.
- The SignPath GitHub App has repository access when required by the configured origin verification policy.

The Draft PR that introduces the signing pipeline must remain unmerged until the real SignPath organization/project/policy/artifact configuration values are available and the first successful signing request has been reviewed.
