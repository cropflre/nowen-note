from pathlib import Path


def gh(expression: str) -> str:
    return '${{ ' + expression + ' }}'


workflow_path = Path('.github/workflows/release.yml')
source = workflow_path.read_text(encoding='utf-8')

old_comment = '#              SIGNPATH_SIGNING_POLICY_SLUG / SIGNPATH_ARTIFACT_CONFIGURATION_SLUG /\n#              NOWEN_WINDOWS_PUBLISHER_NAME'
new_comment = '#              SIGNPATH_SIGNING_POLICY_SLUG / SIGNPATH_FULL_ARTIFACT_CONFIGURATION_SLUG /\n#              SIGNPATH_LITE_ARTIFACT_CONFIGURATION_SLUG / NOWEN_WINDOWS_PUBLISHER_NAME'
if source.count(old_comment) != 1:
    raise SystemExit(f'comment anchor count={source.count(old_comment)}')
source = source.replace(old_comment, new_comment, 1)

old_env = f'          SIGNPATH_ARTIFACT_CONFIGURATION_SLUG: {gh("vars.SIGNPATH_ARTIFACT_CONFIGURATION_SLUG")}\n          NOWEN_WINDOWS_PUBLISHER_NAME:'
new_env = f'          SIGNPATH_FULL_ARTIFACT_CONFIGURATION_SLUG: {gh("vars.SIGNPATH_FULL_ARTIFACT_CONFIGURATION_SLUG")}\n          SIGNPATH_LITE_ARTIFACT_CONFIGURATION_SLUG: {gh("vars.SIGNPATH_LITE_ARTIFACT_CONFIGURATION_SLUG")}\n          NOWEN_WINDOWS_PUBLISHER_NAME:'
if source.count(old_env) != 1:
    raise SystemExit(f'config env anchor count={source.count(old_env)}')
source = source.replace(old_env, new_env, 1)

check_anchor = '      - name: Check SignPath release configuration\n'
version_step = '''      - name: Resolve package version for SignPath
        id: package_version
        shell: bash
        run: echo "version=$(node -p 'require(\\"./package.json\\").version')" >> "$GITHUB_OUTPUT"

'''
if source.count(check_anchor) != 1:
    raise SystemExit(f'check step anchor count={source.count(check_anchor)}')
source = source.replace(check_anchor, version_step + check_anchor, 1)

full_old = f'          artifact-configuration-slug: {gh("vars.SIGNPATH_ARTIFACT_CONFIGURATION_SLUG")}\n          github-artifact-id: {gh("steps.upload_full_unsigned.outputs.artifact-id")}'
full_new = f'          artifact-configuration-slug: {gh("vars.SIGNPATH_FULL_ARTIFACT_CONFIGURATION_SLUG")}\n          github-artifact-id: {gh("steps.upload_full_unsigned.outputs.artifact-id")}\n          parameters: |\n            version: {gh("toJSON(steps.package_version.outputs.version)")}'
if source.count(full_old) != 1:
    raise SystemExit(f'full artifact anchor count={source.count(full_old)}')
source = source.replace(full_old, full_new, 1)

lite_old = f'          artifact-configuration-slug: {gh("vars.SIGNPATH_ARTIFACT_CONFIGURATION_SLUG")}\n          github-artifact-id: {gh("steps.upload_lite_unsigned.outputs.artifact-id")}'
lite_new = f'          artifact-configuration-slug: {gh("vars.SIGNPATH_LITE_ARTIFACT_CONFIGURATION_SLUG")}\n          github-artifact-id: {gh("steps.upload_lite_unsigned.outputs.artifact-id")}\n          parameters: |\n            version: {gh("toJSON(steps.package_version.outputs.version)")}'
if source.count(lite_old) != 1:
    raise SystemExit(f'lite artifact anchor count={source.count(lite_old)}')
source = source.replace(lite_old, lite_new, 1)

upload_anchor = '      - name: Upload allowlisted Release assets\n'
release_policy_step = f'''      - name: Ensure Release code signing policy
        env:
          GH_TOKEN: {gh("secrets.GITHUB_TOKEN")}
          TAG: {gh("steps.version.outputs.tag")}
        shell: bash
        run: |
          set -euo pipefail
          CURRENT_NOTES="$(gh release view "$TAG" --repo "$GITHUB_REPOSITORY" --json body --jq '.body // ""')"
          if ! grep -q '^## Code signing policy$' <<<"$CURRENT_NOTES"; then
            NOTES_FILE="$(mktemp)"
            {{
              printf '%s\\n\\n' '## Code signing policy'
              printf '%s\\n\\n' 'Free code signing provided by SignPath.io, certificate by SignPath Foundation.'
              printf '%s\\n\\n' 'Policy: https://github.com/cropflre/nowen-note/blob/main/docs/CODE_SIGNING.md'
              printf '%s\\n\\n' 'Privacy: https://github.com/cropflre/nowen-note/blob/main/docs/PRIVACY.md'
              printf '%s\\n' "$CURRENT_NOTES"
            }} > "$NOTES_FILE"
            gh release edit "$TAG" --repo "$GITHUB_REPOSITORY" --notes-file "$NOTES_FILE"
            rm -f "$NOTES_FILE"
          fi

'''
if source.count(upload_anchor) != 1:
    raise SystemExit(f'upload assets anchor count={source.count(upload_anchor)}')
source = source.replace(upload_anchor, release_policy_step + upload_anchor, 1)
workflow_path.write_text(source, encoding='utf-8')

package_path = Path('package.json')
package_source = package_path.read_text(encoding='utf-8')
old_test = 'scripts/tests/signpath-policy-docs.test.cjs"'
new_test = 'scripts/tests/signpath-policy-docs.test.cjs scripts/tests/signpath-artifact-config.test.cjs"'
if package_source.count(old_test) != 1:
    raise SystemExit(f'package test anchor count={package_source.count(old_test)}')
package_path.write_text(package_source.replace(old_test, new_test, 1), encoding='utf-8')

Path('.github/workflows/apply-signpath-application-readiness.yml').unlink(missing_ok=True)
Path('scripts/apply-signpath-readiness-patch.py').unlink()
