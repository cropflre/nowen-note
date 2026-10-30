# A14 Capacitor security patch

Official advisory: https://github.com/ionic-team/capacitor/security/advisories/GHSA-rvm3-566m-v7fv

The internal HTTP proxy could serve a remote document at the application origin. Disabling CapacitorHttp alone does not address the vulnerable navigation path. Use the fixed 8.4.3 patch line, pinning core/CLI/Android in the root and core/CLI/Android/iOS in frontend; preserve the existing app ID, origin, storage and native plugin configuration. Root previously mixed Capacitor 7 CLI and 8 runtime; both entry points now resolve the same reviewed runtime.

The version/lock regression failed before the dependency upgrade. All four security contract tests pass afterward, including installed native proxy/navigation guards and the native project references. `npm ls @capacitor/core @capacitor/android @capacitor/ios @capacitor/cli --all` has no peer errors. No force/audit-fix command was used.

Both `cap sync android` and `cap sync ios` completed and discovered 13 native plugins. CocoaPods generated Podfile.lock with Capacitor/CapacitorCordova 8.4.3, the workspace and framework input/output paths. Android's generated Gradle dependency paths remain unchanged: they include the updated, lockfile-resolved @capacitor/android/capacitor project.

Actual local validation:

- Frontend TypeScript + production Vite build: passed.
- Android Studio JDK + Android SDK: `bash gradlew assembleDebug`, BUILD SUCCESSFUL; 440 tasks executed. This compiles the registered plugin projects and packages the app.
- Xcode 27: workspace App, Debug, iphonesimulator, CODE_SIGNING_ALLOWED=NO, BUILD SUCCEEDED for arm64/x86_64 simulator targets, including native plugin dependencies.
- Four contract tests: `node --test scripts/tests/capacitor-security.test.cjs`, passed.
- Post-upgrade npm audit no longer reports Capacitor. Other advisory findings are outside A14 and remain unresolved.

These are local Debug compilation/packaging and source-contract checks, not a physical-device exploit test, signed release archive, app-store submission, installed upgrade/data-retention signoff or release authorization. Rebuild and redistribute reviewed release candidates before calling deployed devices fixed.
