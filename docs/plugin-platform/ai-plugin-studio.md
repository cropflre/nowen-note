# AI Plugin Studio / Extension Platform V2.1

> Status: implementation scaffold on `release/v1.5.0`; product delivery target starts at Nowen 1.6.0.

## Release boundary

V2.1 code is developed behind fail-closed feature gates. The 1.5.0 host version is **not** rewritten to 1.6.0, so a package declaring `engines.nowen: ">=1.6.0"` remains incompatible on an ordinary 1.5.0 instance. This prevents experimental implementation work from silently changing the compatibility contract of the current release branch.

Environment gates:

| Capability | Environment variable | Default |
| --- | --- | --- |
| Extension Platform V2.1 contracts/runtime | `NOWEN_EXTENSIONS_V21` | off |
| AI Plugin Studio | `NOWEN_PLUGIN_STUDIO` | off; requires V2.1 |
| File processing extensions | `NOWEN_FILE_PROCESSING_EXTENSIONS` | off; requires V2.1 |
| Experimental document types | `NOWEN_EXPERIMENTAL_DOCUMENT_TYPES` | off; requires file processing |

The effective state is available from `GET /api/plugins/features`. Feature detection is informational only; authorization, compatibility and package validation remain server-side responsibilities.

## Safety invariants

Feature gates do not weaken existing Plugin V1/V2 security boundaries. When V2.1 is disabled, manifest parsing, installation, execution, update, rollback, Marketplace cache and offline behavior must remain equivalent to the existing 1.5.0 platform.

The V2.1 implementation must continue to enforce these invariants:

- Community executable plugins remain `sandbox-js`; a feature flag cannot opt them into Node Runtime.
- Declarative plugins execute no code and receive no Host API/data permission implicitly.
- Plugin Studio never receives Registry signing keys, stored AI provider secrets, arbitrary filesystem access, shell access or unrestricted network access.
- Experimental document types remain off until the file capability broker and its security gate exist.
- Restore always quarantines extensions and revalidates source, signature/advisory state and permissions.

## Planned release sequence

The implementation follows `docs/superpowers/plans/2026-09-12-ai-native-extension-platform-v2-1.md`:

1. feature gates and release CI;
2. unified generated capability catalog;
3. pure declarative runtime;
4. safe Appearance Contribution and Theme Pack dogfood;
5. only after the above release gate: templates, prompt packs and Plugin Studio Alpha;
6. file processing/import-export; document type preview; Marketplace GA in later stages.

Later-stage routes or UI must not be represented as available merely because their feature flag name exists.
