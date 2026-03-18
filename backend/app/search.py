from tavily import TavilyClient

from app.config import settings


def get_tavily_client() -> TavilyClient:
    return TavilyClient(api_key=settings.tavily_api_key)


async def search_images(query: str, max_results: int = 5) -> list[dict]:
    """Search for images using Tavily. Returns list of {url, description}."""
    client = get_tavily_client()

    response = client.search(
        query=query,
        search_depth="basic",
        include_images=True,
        include_image_descriptions=True,
        max_results=max_results,
    )

    images = response.get("images", [])

    # Normalize response format
    results = []
    for img in images:
        if isinstance(img, dict):
            results.append(
                {
                    "url": img.get("url", ""),
                    "description": img.get("description", ""),
                }
            )
        elif isinstance(img, str):
            results.append({"url": img, "description": ""})

    return results
