"""Deterministic edits shared by the UI and agent tools."""

from typing import Literal

from PIL import Image
from pydantic import BaseModel, Field, model_validator

from app.image_processing import (
    add_text_to_image,
    crop_and_resize,
    get_image_path,
    prepare_for_slack,
)


class Crop(BaseModel):
    x: float = Field(ge=0, lt=100)
    y: float = Field(ge=0, lt=100)
    width: float = Field(gt=0, le=100)
    height: float = Field(gt=0, le=100)

    @model_validator(mode="after")
    def within_image(self):
        if self.x + self.width > 100 or self.y + self.height > 100:
            raise ValueError("Crop must stay within the image")
        return self


class EditRequest(BaseModel):
    image_id: str = Field(pattern=r"^[a-f0-9]{12}$")
    crop: Crop | None = None
    text: str | None = Field(default=None, max_length=40)
    position: Literal["top", "center", "bottom"] = "bottom"
    font_size: int = Field(default=24, ge=10, le=48)


def edit_image(body: EditRequest) -> dict:
    path = get_image_path(body.image_id)
    if not path:
        raise FileNotFoundError("This image is no longer available. Search again.")
    image_id = body.image_id
    if body.crop:
        with Image.open(path) as image:
            w, h = image.size
        c = body.crop
        left, top = int(w * c.x / 100), int(h * c.y / 100)
        box = (
            left,
            top,
            max(left + 1, int(w * (c.x + c.width) / 100)),
            max(top + 1, int(h * (c.y + c.height) / 100)),
        )
        image_id = crop_and_resize(image_id, crop_box=box)
    else:
        image_id = crop_and_resize(image_id)
    # Apply text at the output size so it remains legible in Slack.
    text_source_id = image_id
    if body.text:
        image_id = add_text_to_image(image_id, body.text, body.position, body.font_size)
    final_id = prepare_for_slack(image_id)
    return {
        "image_id": final_id,
        "image_url": f"/api/images/{final_id}",
        "download_url": f"/api/download/{final_id}",
        "source_id": body.image_id,
        "text_source_id": text_source_id,
        "text": body.text or "",
        "position": body.position,
        "font_size": body.font_size,
    }
