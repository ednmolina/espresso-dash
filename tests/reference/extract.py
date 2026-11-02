"""Regenerate (or verify) the vendored golden reference ``analysis_e299811_stable.py``.

    python tests/reference/extract.py           # rewrite the vendored file from git
    python tests/reference/extract.py --check   # exit 1 if the vendored file differs

Source: ``cloudrun/coffeegrindsize_core/analysis.py`` at commit e299811, the last
pure-NumPy implementation. The only change is that every ``np.argsort`` becomes a
stable sort via ``_stable_argsort`` (numpy's default quicksort/introsort is not
stable, so tie order is hardware dependent; a stable oracle is deterministic).
"""
from __future__ import annotations

import hashlib
import pathlib
import subprocess
import sys

COMMIT = "e299811"
SRC = "cloudrun/coffeegrindsize_core/analysis.py"
OUT = pathlib.Path(__file__).with_name("analysis_e299811_stable.py")

HEADER = f'''\
# Vendored golden reference: {SRC} @ {COMMIT} (pure NumPy, no numba).
# Modification: every ``np.argsort(x)`` is replaced by ``_stable_argsort(x)`` (kind="stable").
# DO NOT EDIT. Regenerate with:  python tests/reference/extract.py  (verify: --check).
# Used only by tests/ as an exact-equality oracle for the numba implementation.
# Production code must never import it (see tests/core/test_guard.py).
'''
HELPER = '''
def _stable_argsort(values):
    return np.argsort(values, kind="stable")

'''


def build() -> str:
    repo = pathlib.Path(__file__).resolve().parents[2]
    src = subprocess.run(["git", "show", f"{COMMIT}:{SRC}"], cwd=repo, check=True,
                         capture_output=True, text=True).stdout
    assert "np.argsort(" in src
    src = src.replace("np.argsort(", "_stable_argsort(")
    marker = "DEFAULT_REFERENCE_THRESHOLD"
    head, tail = src.split(marker, 1)
    return HEADER + head.rstrip("\n") + "\n" + HELPER + "\n" + marker + tail


def main() -> int:
    text = build()
    digest = hashlib.sha256(text.encode()).hexdigest()
    if "--check" in sys.argv:
        ok = OUT.exists() and OUT.read_text() == text
        print(("OK " if ok else "MISMATCH ") + digest)
        return 0 if ok else 1
    OUT.write_text(text)
    print("wrote", OUT, digest)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
