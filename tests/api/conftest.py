import io
import struct
import zlib

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from tests.synth import crisp_ellipses, soft_field


@pytest.fixture(scope="session")
def main_module():
    import main  # cloudrun/main.py; LOCAL_DEV is set in tests/conftest.py
    return main


@pytest.fixture(scope="session")
def client(main_module):
    # `with` so the lifespan (startup checks + kernel warm-up thread) runs
    with TestClient(main_module.app) as c:
        yield c


def png_bytes(img: Image.Image) -> bytes:
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


def fake_png_header(width: int, height: int) -> bytes:
    """Tiny PNG whose IHDR claims huge dimensions (rejected from the header, never decoded)."""
    def chunk(tag: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 0, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(b"\0" * 16)) + chunk(b"IEND", b"")


@pytest.fixture(scope="session")
def upload(client):
    def _up(img: Image.Image) -> str:
        r = client.post("/upload", files={"file": ("x.png", png_bytes(img), "image/png")})
        assert r.status_code == 200, r.text
        return r.json()["image_id"]
    return _up


@pytest.fixture(scope="session")
def photo():
    """2400x1800 stand-in for bench/photo.jpg (soft particles, vignette, noise)."""
    return soft_field(2400, 1800, 2500, seed=3)


@pytest.fixture(scope="session")
def photo_id(upload, photo):
    return upload(photo)


@pytest.fixture(scope="session")
def small_id(upload):
    return upload(soft_field(600, 450, 400, seed=7))


REF = {"reference_points": [[100, 100], [300, 100]], "reference_physical_mm": 10}


@pytest.fixture(scope="session")
def analysis(client, small_id):
    """A completed scaled analysis of the small image: (frozen analysis_id, analyze-body).

    The frozen id keeps working when other tests re-analyse the same image (image_id = "latest").
    """
    r = client.post("/analyze", json={"image_id": small_id, **REF})
    assert r.status_code == 200, r.text
    body = r.json()
    return body["analysis_id"], body
