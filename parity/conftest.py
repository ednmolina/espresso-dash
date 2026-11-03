"""Environment for the JS-fixture exporter and its drift test (mirrors tests/conftest.py).

Lives outside tests/ on purpose: check-protected.mjs freezes everything under tests/.
"""
import os
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
REPO = pathlib.Path(os.environ.get("ESPRESSO_REPO", ROOT))
sys.path.insert(0, str(REPO / "cloudrun"))
sys.path.insert(0, str(ROOT))  # so `import tests.synth` works
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))  # `import export_js_fixtures`
os.environ["LOCAL_DEV"] = "true"
os.environ.pop("GCS_BUCKET", None)
os.environ.setdefault("NUMBA_CACHE_DIR", str(ROOT / ".numba_cache"))
