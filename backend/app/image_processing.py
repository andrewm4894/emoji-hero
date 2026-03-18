import io
import uuid
from pathlib import Path

import httpx
from PIL import Image, ImageDraw, ImageFont

from app.config import settings

STORAGE = Path(settings.image_storage_dir)
STORAGE.mkdir(parents=True, exist_ok=True)

SLACK_MAX_SIZE = 128 * 1024  # 128KB
SLACK_DIMENSIONS = (128, 128)


async def download_image(url: str) -> tuple[str, str]:
    """Download an image from URL, save to storage, return (image_id, file_path)."""
    async with httpx.AsyncClient(follow_redirects=True, timeout=30) as client:
        resp = await client.get(url)
        resp.raise_for_status()

    image_id = uuid.uuid4().hex[:12]
    # Detect format from content
    img = Image.open(io.BytesIO(resp.content))
    if img.mode == "RGBA":
        ext = "png"
    else:
        ext = "png"
        img = img.convert("RGBA")

    file_path = STORAGE / f"{image_id}.{ext}"
    img.save(str(file_path), "PNG")
    return image_id, str(file_path)


def add_text_to_image(
    image_id: str,
    text: str,
    position: str = "bottom",
    font_size: int = 24,
    color: str = "white",
    stroke_color: str = "black",
    stroke_width: int = 2,
) -> str:
    """Add text overlay to an image. Returns new image_id."""
    src_path = _find_image(image_id)
    img = Image.open(src_path).convert("RGBA")

    # Create text overlay
    txt_layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(txt_layer)

    # Try to use a good font, fall back to default
    try:
        font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", font_size)
    except (OSError, IOError):
        try:
            font = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", font_size)
        except (OSError, IOError):
            font = ImageFont.load_default()

    # Calculate text position
    bbox = draw.textbbox((0, 0), text, font=font)
    text_w = bbox[2] - bbox[0]
    text_h = bbox[3] - bbox[1]

    padding = 4
    if position == "top":
        xy = ((img.width - text_w) // 2, padding)
    elif position == "center":
        xy = ((img.width - text_w) // 2, (img.height - text_h) // 2)
    else:  # bottom
        xy = ((img.width - text_w) // 2, img.height - text_h - padding)

    draw.text(
        xy,
        text,
        font=font,
        fill=color,
        stroke_width=stroke_width,
        stroke_fill=stroke_color,
    )

    result = Image.alpha_composite(img, txt_layer)

    new_id = uuid.uuid4().hex[:12]
    out_path = STORAGE / f"{new_id}.png"
    result.save(str(out_path), "PNG")
    return new_id


def crop_and_resize(
    image_id: str,
    crop_box: tuple[int, int, int, int] | None = None,
    size: tuple[int, int] = SLACK_DIMENSIONS,
) -> str:
    """Crop and/or resize an image. Returns new image_id."""
    src_path = _find_image(image_id)
    img = Image.open(src_path).convert("RGBA")

    if crop_box:
        img = img.crop(crop_box)

    # Resize maintaining aspect ratio, fitting within the target size
    img.thumbnail(size, Image.Resampling.LANCZOS)

    # If not square, paste onto transparent square canvas
    if img.size != size:
        canvas = Image.new("RGBA", size, (0, 0, 0, 0))
        offset = ((size[0] - img.width) // 2, (size[1] - img.height) // 2)
        canvas.paste(img, offset, img)
        img = canvas

    new_id = uuid.uuid4().hex[:12]
    out_path = STORAGE / f"{new_id}.png"
    img.save(str(out_path), "PNG")
    return new_id


def prepare_for_slack(image_id: str) -> str:
    """Optimize image for Slack: 128x128 PNG, under 128KB. Returns new image_id."""
    src_path = _find_image(image_id)
    img = Image.open(src_path).convert("RGBA")

    # Resize to 128x128
    img.thumbnail(SLACK_DIMENSIONS, Image.Resampling.LANCZOS)

    # Center on transparent square canvas if not already square
    if img.size != SLACK_DIMENSIONS:
        canvas = Image.new("RGBA", SLACK_DIMENSIONS, (0, 0, 0, 0))
        offset = ((SLACK_DIMENSIONS[0] - img.width) // 2, (SLACK_DIMENSIONS[1] - img.height) // 2)
        canvas.paste(img, offset, img)
        img = canvas

    new_id = uuid.uuid4().hex[:12]
    out_path = STORAGE / f"{new_id}.png"

    # Save and check size, reduce quality if needed
    img.save(str(out_path), "PNG", optimize=True)

    # If still too large, quantize colors to reduce size
    if out_path.stat().st_size > SLACK_MAX_SIZE:
        img_quantized = img.quantize(colors=128, method=Image.Quantize.MEDIANCUT)
        img_quantized = img_quantized.convert("RGBA")
        img_quantized.save(str(out_path), "PNG", optimize=True)

    # Last resort: shrink dimensions
    current_size = SLACK_DIMENSIONS
    while out_path.stat().st_size > SLACK_MAX_SIZE and current_size[0] > 32:
        current_size = (current_size[0] - 16, current_size[1] - 16)
        img_small = img.resize(current_size, Image.Resampling.LANCZOS)
        img_small.save(str(out_path), "PNG", optimize=True)

    return new_id


def get_image_path(image_id: str) -> str | None:
    """Get the file path for an image by ID, or None if not found."""
    path = _find_image(image_id)
    return str(path) if path else None


def _find_image(image_id: str) -> Path | None:
    """Find an image file by ID in storage."""
    for ext in ("png", "jpg", "gif"):
        path = STORAGE / f"{image_id}.{ext}"
        if path.exists():
            return path
    return None
