"""Oracles for the Slack-optimization boundary in app/image_processing.py.

Every emoji that leaves `prepare_for_slack` must satisfy Slack's custom-emoji limits:
PNG, no side larger than 128px, file under 128KB. The boundary oracle iterates the
live domain `IMAGE_EXTS` — every on-disk format the service admits — with an
incompressible source, the worst case for PNG.
"""

import os
import uuid

import pytest
from PIL import Image

from app import image_processing as ip
from app.image_processing import IMAGE_EXTS

_PIL_FORMAT = {"png": "PNG", "jpg": "JPEG", "gif": "GIF"}


def _store_image(img: Image.Image, ext: str = "png") -> str:
    image_id = uuid.uuid4().hex[:12]
    fmt = _PIL_FORMAT[ext]
    if fmt == "JPEG":
        img = img.convert("RGB")
    img.save(str(ip.STORAGE / f"{image_id}.{ext}"), fmt)
    return image_id


def _noisy_image(size: tuple[int, int]) -> Image.Image:
    """Incompressible RGBA noise — forces the quantize / shrink fallbacks to engage."""
    return Image.frombytes("RGBA", size, os.urandom(size[0] * size[1] * 4))


def _assert_slack_ready(out_id: str) -> None:
    path = ip.get_image_path(out_id)
    assert path is not None
    out = Image.open(path)
    assert out.format == "PNG"
    assert out.width <= ip.SLACK_DIMENSIONS[0]
    assert out.height <= ip.SLACK_DIMENSIONS[1]
    assert os.path.getsize(path) <= ip.SLACK_MAX_SIZE


@pytest.mark.parametrize("ext", IMAGE_EXTS)
def test_slack_boundary_holds_for_every_admitted_format(ext):
    """Totality oracle: for EVERY format `_find_image` admits, the artifact fits Slack."""
    assert len(IMAGE_EXTS) >= 3  # domain floor — vacuous if the registry empties
    assert ext in _PIL_FORMAT, f"new admitted format {ext!r} needs a PIL mapping here"
    src = _store_image(_noisy_image((1024, 1024)), ext)
    _assert_slack_ready(ip.prepare_for_slack(src))


def test_prepare_for_slack_fits_dimensions():
    src = _store_image(Image.new("RGBA", (900, 600), (255, 0, 0, 255)))
    out = Image.open(ip.get_image_path(ip.prepare_for_slack(src)))
    assert out.format == "PNG"
    assert out.width <= ip.SLACK_DIMENSIONS[0]
    assert out.height <= ip.SLACK_DIMENSIONS[1]


def test_prepare_for_slack_pads_non_square_to_square():
    src = _store_image(Image.new("RGBA", (400, 100), (0, 255, 0, 255)))
    out = Image.open(ip.get_image_path(ip.prepare_for_slack(src)))
    assert out.size == ip.SLACK_DIMENSIONS


def test_prepare_for_slack_returns_new_immutable_id():
    src = _store_image(Image.new("RGBA", (64, 64), (0, 0, 255, 255)))
    out_id = ip.prepare_for_slack(src)
    assert out_id != src
    assert len(out_id) == 12
    # The source is untouched — every processing step is a new artifact.
    assert ip.get_image_path(src) is not None


def test_get_image_path_unknown_id_is_none():
    assert ip.get_image_path("doesnotexist0") is None
