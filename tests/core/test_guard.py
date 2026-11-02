"""Production code must never depend on the test-only reference oracle."""
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[2]


def test_production_does_not_import_tests_reference():
    offenders = []
    for base in (ROOT / "cloudrun", ROOT / "coffeegrindsize_core"):
        if not base.exists():
            continue
        for p in base.rglob("*.py"):
            if "__pycache__" in p.parts:
                continue
            text = p.read_text(errors="ignore")
            if "tests.reference" in text or "analysis_e299811" in text:
                offenders.append(str(p.relative_to(ROOT)))
    assert not offenders, offenders


def test_vendored_reference_is_unmodified():
    import subprocess, sys
    r = subprocess.run([sys.executable, str(ROOT / "tests/reference/extract.py"), "--check"],
                       cwd=ROOT, capture_output=True, text=True)
    assert r.returncode == 0, r.stdout + r.stderr
