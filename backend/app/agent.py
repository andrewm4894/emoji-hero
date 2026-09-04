import asyncio
import json

from openai import AsyncOpenAI
from pydantic import BaseModel
from pydantic_ai import Agent, RunContext
from pydantic_ai.models.openai import OpenAIChatModel
from pydantic_ai.providers.openai import OpenAIProvider

from app.config import settings
from app.image_processing import (
    IMAGE_METADATA,
    add_text_to_image,
    crop_and_resize,
    download_image,
    prepare_for_slack,
)
from app.search import search_images


class EmojiDeps(BaseModel):
    """Dependencies injected into the agent at runtime."""

    distinct_id: str = "anonymous"


SYSTEM_PROMPT = """Help users find and edit Slack emoji. Be concise and factual.
Search immediately unless the request is ambiguous. Search results are shown as clickable
cards by the app: do not repeat image markdown, numbered lists, or URLs. Say only
"Select an image to continue." If there are no results, suggest another search.
Use the supplied image_id when the user selects an image. Never download it again.
The UI offers precise crop and text controls. Do not claim to crop a face or object
unless the user supplied crop coordinates. For a visual crop request, tell them to
use Crop on the image card. You cannot see image contents or infer crop coordinates.
For text, call add_text directly; it normalizes size and replaces any previous label.
When available, use text_source_id to replace a label without layering it. Always call
make_slack_ready after editing. Do not print download paths: the UI shows Download.
Do not claim success when a tool failed. Describe only edits actually performed.
"""

openai_client = AsyncOpenAI(
    base_url="https://openrouter.ai/api/v1",
    api_key=settings.openrouter_api_key,
)

model = OpenAIChatModel(
    settings.openrouter_model,
    provider=OpenAIProvider(openai_client=openai_client),
)

emoji_agent = Agent(
    model,
    deps_type=EmojiDeps,
    system_prompt=SYSTEM_PROMPT,
)


@emoji_agent.tool
async def search_for_images(ctx: RunContext[EmojiDeps], query: str) -> str:
    """Search the web for images matching the query. Use this to find memes, \
    reaction images, or any visual content the user is looking for."""
    results = await search_images(query)

    async def verify(img):
        try:
            image_id, _ = await download_image(img["url"])
            return {
                "image_id": image_id,
                "image_url": f"/api/images/{image_id}",
                "description": img["description"] or "Search result",
            }
        except Exception:
            return None

    # Serve decoded copies, avoiding broken links and browser hotlink failures.
    verified = await asyncio.gather(*(verify(img) for img in results[:8]))
    return json.dumps([img for img in verified if img])


@emoji_agent.tool
async def download_and_save_image(ctx: RunContext[EmojiDeps], url: str) -> str:
    """Download an image from a URL and save it for processing. \
    Returns the image_id to use with other tools."""
    try:
        image_id, path = await download_image(url)
        return f"Downloaded! image_id: {image_id}"
    except Exception as e:
        return f"Failed to download image: {e}"


@emoji_agent.tool
async def add_text(
    ctx: RunContext[EmojiDeps],
    image_id: str,
    text: str,
    position: str = "bottom",
    font_size: int = 24,
    color: str = "white",
) -> str:
    """Add text overlay to an image. Position can be 'top', 'center', or 'bottom'. \
    Returns a new image_id with the text applied."""
    try:
        source_id = IMAGE_METADATA.get(image_id, {}).get("text_source_id", image_id)
        normalized_id = crop_and_resize(source_id)
        new_id = add_text_to_image(
            normalized_id, text, position=position, font_size=font_size, color=color
        )
        return f"Text added! New image_id: {new_id}"
    except Exception as e:
        return f"Failed to add text: {e}"


@emoji_agent.tool
async def resize_image(
    ctx: RunContext[EmojiDeps],
    image_id: str,
    width: int = 128,
    height: int = 128,
    crop_box: tuple[int, int, int, int] | None = None,
) -> str:
    """Resize and crop an image. Returns a new image_id."""
    try:
        new_id = crop_and_resize(image_id, crop_box=crop_box, size=(width, height))
        return f"Resized! New image_id: {new_id}"
    except Exception as e:
        return f"Failed to resize: {e}"


@emoji_agent.tool
async def make_slack_ready(ctx: RunContext[EmojiDeps], image_id: str) -> str:
    """Prepare an image for Slack: optimizes to 128x128 PNG under 128KB. \
    This is the final step before download. Returns the final image_id."""
    try:
        new_id = prepare_for_slack(image_id)
        return f"Slack-ready! Final image_id: {new_id} — the user can download this at /api/download/{new_id}"
    except Exception as e:
        return f"Failed to prepare for Slack: {e}"
