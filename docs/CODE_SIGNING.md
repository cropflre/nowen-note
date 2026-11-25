# Windows distribution and code-signing policy

## Channels

- **GitHub Direct EXE (NSIS and Portable)**: Windows EXE packages are currently **unsigned**. The user may see Windows SmartScreen and "Unknown publisher". This does not mean malicious software, but users should verify the GitHub project and release provenance before running an installer. They do not inherit any Microsoft Store signature.
- **Microsoft Store AppX**: a completely separate build and Partner Center submission. Microsoft Store will sign the accepted Store package and manage Store-version updates after certification. The Store package does not sign the GitHub EXEs.
- **macOS / Android / Linux**: existing platform-specific signing, packaging and release mechanisms are unchanged.

## GitHub Direct release integrity gates

The release workflow builds Windows from one Git tag (Lite packages are no longer built since 1.6.1). The release publisher keeps a Draft release until:
1. Windows CI provides the exact expected setup and portable executables, the NSIS blockmap, and `latest.yml` metadata.
2. The builder metadata version and SHA-512 update fields validate locally.
3. Local Windows release candidates are replaced by artifacts downloaded from the same Git commit / tag workflow.
4. Remote metadata and release assets pass verification.

The workflow always uses `electron-builder --publish never` and does not publish a formal GitHub Release by itself. The existing Windows Direct in-app updater still opens a release page for manually installing updates; this change does not enable unsigned unattended updates.

**Integrity metadata is not a substitute for signed publisher identity.** A separate future Authenticode solution requires an explicit product decision and new release safeguards.

## Hot-update bundles (project-owned RSA signature)

Hot-update bundles (`nowen-hot-*`) are signed with the project's own RSA-3072 key: the private key lives only in the `NOWEN_HOT_UPDATE_PRIVATE_KEY` Actions secret and offline backups, and the public key is committed in `hot-update/public-keys.json` and built into the app shells. This authenticates the project as the bundle's publisher. It is not Authenticode or Apple Developer ID, and it does not change the installer signing policy above. See [hot-update.md](architecture/hot-update.md).

## No third-party signing dependency

The active Windows GitHub publishing pipeline no longer requires a third-party signing account, token, organization ID, artifact configuration, or signer-common-name bootstrap. Microsoft Store's publisher identity is used only by the Store AppX channel.

The Microsoft Store implementation is under development in a separate PR. Refer to its dedicated release documentation once integrated.
