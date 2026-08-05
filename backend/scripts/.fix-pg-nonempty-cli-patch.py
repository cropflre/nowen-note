from pathlib import Path
import sys

path = Path(sys.argv[1])
text = path.read_text()

bad = '''    '    "  --allow-non-empty-target   Allow planning against non-empty PostgreSQL; apply remains blocked",\\n',
    '    "  --allow-non-empty-target   Permit non-empty PostgreSQL when an explicit conflict policy is set",\\n    "    \\"  --conflict-policy <mode>  abort (default) or overwrite-with-backup\\",\\n',
)
'''

good = '''    '    "  --allow-non-empty-target   Allow planning against non-empty PostgreSQL; apply remains blocked",\\n',
    '    "  --allow-non-empty-target   Permit non-empty PostgreSQL when an explicit conflict policy is set",\\n'
    '    "  --conflict-policy <mode>  abort (default) or overwrite-with-backup",\\n',
)
'''

if bad not in text:
    raise SystemExit("CLI help replacement anchor missing")

path.write_text(text.replace(bad, good, 1))
