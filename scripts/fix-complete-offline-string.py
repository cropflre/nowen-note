from pathlib import Path

path = Path("backend/src/routes/offline-sync.ts")
text = path.read_text(encoding="utf-8")
broken = '.update(resolved.fingerprintParts.sort().join("\n"))'
# The preceding regex replacement interprets the backslash escape and produces
# an actual newline between the TypeScript quotes. Normalize it back to a
# literal backslash-n before compiling the generated source.
if text.count(broken) != 1:
    raise SystemExit(f"expected one broken newline literal, found {text.count(broken)}")
path.write_text(text.replace(broken, '.update(resolved.fingerprintParts.sort().join("\\n"))', 1), encoding="utf-8")
