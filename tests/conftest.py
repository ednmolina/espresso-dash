"""Shared pytest setup: put cloudrun/ on sys.path, force local-dev mode, no GCS."""
import os
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
REPO = pathlib.Path(os.environ.get("ESPRESSO_REPO", ROOT))
sys.path.insert(0, str(REPO / "cloudrun"))
sys.path.insert(0, str(ROOT))  # so `import tests.x` works regardless of rootdir quirks
os.environ["LOCAL_DEV"] = "true"
os.environ.pop("GCS_BUCKET", None)
os.environ.setdefault("NUMBA_CACHE_DIR", str(ROOT / ".numba_cache"))
