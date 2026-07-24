from pathlib import Path

path = Path(__file__).resolve().parents[2] / "frontend/src/types/index.ts"
text = path.read_text(encoding="utf-8")
old = '''  noteTitle?: string;
}

export type ShareEffectiveStatus = "active" | "disabled" | "expired" | "exhausted";'''
new = '''  noteTitle?: string | null;
}

export type ShareEffectiveStatus = "active" | "disabled" | "expired" | "exhausted";'''
if text.count(old) != 1:
    raise RuntimeError("expected one Share.noteTitle integration occurrence")
path.write_text(text.replace(old, new, 1), encoding="utf-8")
