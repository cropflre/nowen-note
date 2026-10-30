# Windows distribution and code-signing policy

## Channels

- **GitHub Direct EXE (NSIS and Portable)**: Windows Full/Lite EXE packages are currently **unsigned**. The user may see Windows SmartScreen and "Unknown publisher". This does not mean malicious software, but users should verify the GitHub project and release provenance before running an installer. They do not inherit any Microsoft Store signature.
- **Microsoft Store AppX**: a completely separate build and Partner Center submission. Microsoft Store will sign the accepted Store package and manage Store-version updates after certification. The Store package does not sign the GitHub EXEs.
- **macOS / Android / Linux**: existing platform-specific signing, packaging and release mechanisms are unchanged.

## GitHub Direct release integrity gates

The release workflow builds Windows Full/Lite from one Git tag. The release publisher keeps a Draft release until:
1. Windows CI provides the exact eight expected Full/Lite executables, NSIS blockmaps, and `latest*.yml` metadata.
2. The builder metadata version and SHA-512 update fields validate locally.
3. Local Windows release candidates are replaced by artifacts downloaded from the same Git commit / tag workflow.
4. Remote metadata and release assets pass verification.

The workflow always uses `electron-builder --publish never` and does not publish a formal GitHub Release by itself. The existing Windows Direct in-app updater still opens a release page for manually installing updates; this change does not enable unsigned unattended updates.

**Integrity metadata is not a substitute for signed publisher identity.** A separate future Authenticode solution requires an explicit product decision and new release safeguards.

## No third-party signing dependency

The active Windows GitHub publishing pipeline no longer requires a third-party signing account, token, organization ID, artifact configuration, or signer-common-name bootstrap. Microsoft Store's publisher identity is used only by the Store AppX channel.

The Microsoft Store implementation is under development in a separate PR. Refer to its dedicated release documentation once integrated.
