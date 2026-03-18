from openai import AsyncOpenAI
from pydantic import BaseModel
from pydantic_ai import Agent, RunContext
from pydantic_ai.models.openai import OpenAIChatModel
from pydantic_ai.providers.openai import OpenAIProvider

from app.config import settings
from app.image_processing import (
    add_text_to_image,
    crop_and_resize,
    download_image,
    prepare_for_slack,
)
from app.search import search_images


class EmojiDeps(BaseModel):
    """Dependencies injected into the agent at runtime."""

    distinct_id: str = "anonymous"


SYSTEM_PROMPT = """\
You are Emoji Hero — a friendly assistant that helps people find, customize, and \
download custom emoji for Slack.

Your workflow:
1. Understand what emoji the user wants (meme, reaction, inside joke, etc.)
2. Search for relevant images using the search tool
3. Present the results and let the user pick one (or refine the search)
4. Apply customizations (text overlay, cropping, resizing) as requested
5. Prepare the final image for Slack (128x128, <128KB PNG) and provide a download link

When presenting search results, describe each image briefly so the user can choose. \
Reference images by their number (1, 2, 3, etc.).

When adding text, suggest good defaults for position and style but let the user override.

Always prepare the final emoji for Slack before telling the user it's ready to download.

Keep responses concise and fun — you're making emoji, not writing essays!
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

    if not results:
        return "No images found. Try a different search query."

    lines = []
    for i, img in enumerate(results, 1):
        desc = img["description"] or "No description"
        lines.append(f"{i}. {desc}\n   URL: {img['url']}")

    return "\n\n".join(lines)


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
        new_id = add_text_to_image(
            image_id, text, position=position, font_size=font_size, color=color
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
) -> str:
    """Resize and crop an image. Returns a new image_id."""
    try:
        new_id = crop_and_resize(image_id, size=(width, height))
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
