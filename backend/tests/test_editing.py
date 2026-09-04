import asyncio
import json
import uuid
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient
from PIL import Image
from pydantic import ValidationError

from app import image_processing as ip
from app.editing import Crop, EditRequest, edit_image
from app.main import app


def source():
    image_id = uuid.uuid4().hex[:12]
    image = Image.new("RGBA", (400, 200), "red")
    image.paste("blue", (200, 0, 400, 200))
    image.save(ip.STORAGE / f"{image_id}.png")
    return image_id


def test_crop_uses_selected_region_and_keeps_source():
    image_id = source()
    original = (ip.STORAGE / f"{image_id}.png").read_bytes()
    result = edit_image(
        EditRequest(image_id=image_id, crop=Crop(x=50, y=0, width=50, height=100))
    )
    with Image.open(ip.get_image_path(result["image_id"])) as image:
        assert image.size == (128, 128)
        assert image.getpixel((64, 64)) == (0, 0, 255, 255)
    assert (ip.STORAGE / f"{image_id}.png").read_bytes() == original
    assert result["image_id"] != image_id


def test_text_is_applied_at_final_size_and_replaceable():
    result = edit_image(EditRequest(image_id=source(), text="FINE"))
    with Image.open(ip.get_image_path(result["image_id"])) as image:
        assert image.size == (128, 128)
        assert (
            sum(
                1
                for r, g, b, a in image.get_flattened_data()
                if r > 200 and g > 200 and b > 200 and a
            )
            > 50
        )
    cleared = edit_image(EditRequest(image_id=result["text_source_id"], text=""))
    with Image.open(ip.get_image_path(cleared["image_id"])) as image:
        assert not any(
            r > 200 and g > 200 and b > 200 and a for r, g, b, a in image.get_flattened_data()
        )


def test_rejects_out_of_bounds_crop():
    with pytest.raises(ValidationError):
        Crop(x=75, y=0, width=50, height=100)
    with pytest.raises(ValueError):
        ip.crop_and_resize(source(), crop_box=(-1, 0, 100, 100))


def test_edit_api_and_expired_images():
    with TestClient(app) as client:
        result = client.post("/api/edit", json={"image_id": source(), "text": "OK"})
        assert result.status_code == 200
        download = client.get(result.json()["download_url"])
        assert download.status_code == 200
        assert download.headers["content-type"] == "image/png"
        assert len(download.content) < ip.SLACK_MAX_SIZE
        assert (
            client.post("/api/edit", json={"image_id": "000000000000"}).status_code
            == 404
        )
        assert client.get("/api/images/000000000000").status_code == 404
        assert (
            client.post(
                "/api/edit",
                json={
                    "image_id": source(),
                    "crop": {"x": 90, "y": 0, "width": 50, "height": 100},
                },
            ).status_code
            == 422
        )


def test_search_filters_failed_downloads(monkeypatch):
    from app import agent

    monkeypatch.setattr(
        agent,
        "search_images",
        AsyncMock(
            return_value=[
                {"url": "https://example.com/good.png", "description": "Good"},
                {"url": "https://example.com/broken.png", "description": "Broken"},
            ]
        ),
    )
    monkeypatch.setattr(
        agent,
        "download_image",
        AsyncMock(
            side_effect=[("abcdef123456", "/tmp/test.png"), ValueError("Not an image")]
        ),
    )
    results = json.loads(asyncio.run(agent.search_for_images(None, "test")))
    assert len(results) == 1
    assert results[0]["image_url"] == "/api/images/abcdef123456"


def test_stream_emits_structured_results_and_restored_context(monkeypatch):
    from pydantic_ai import FunctionToolCallEvent, FunctionToolResultEvent
    from pydantic_ai.messages import ToolCallPart, ToolReturnPart

    from app import main

    captured = {}

    class StubAgent:
        async def run_stream_events(self, prompt, **kwargs):
            captured["prompt"] = prompt
            yield FunctionToolCallEvent(
                ToolCallPart("search_for_images", '{"query":"dog"}')
            )
            yield FunctionToolResultEvent(
                ToolReturnPart(
                    "search_for_images",
                    json.dumps(
                        [
                            {
                                "image_id": "abcdef123456",
                                "image_url": "/api/images/abcdef123456",
                                "description": "Dog",
                            }
                        ]
                    ),
                )
            )

    monkeypatch.setattr(main, "emoji_agent", StubAgent())
    monkeypatch.setattr(main, "setup_otel", lambda **kwargs: None)
    with TestClient(app) as client:
        response = client.post(
            "/api/chat",
            json={
                "message": "Crop this",
                "session_id": "restore-test",
                "history": [
                    {"role": "assistant", "content": "Selected image abcdef123456"}
                ],
            },
        )
    chunks = [
        json.loads(line[6:])
        for line in response.text.splitlines()
        if line.startswith("data: ")
    ]
    assert chunks[0]["args"] == {"query": "dog"}
    assert any(c["type"] == "search_results" and len(c["results"]) == 1 for c in chunks)
    assert "abcdef123456" in captured["prompt"]
    assert not any(c["type"] == "error" for c in chunks)


def test_agent_text_replacement_after_resize_uses_clean_source():
    from app import agent
    result = edit_image(EditRequest(image_id=source(), text="FINE"))
    resized = ip.crop_and_resize(result["image_id"])
    response = asyncio.run(agent.add_text(None, resized, "OK"))
    new_id = response.split("image_id: ")[1]
    expected = ip.add_text_to_image(result["text_source_id"], "OK")
    with Image.open(ip.get_image_path(new_id)) as actual_image, Image.open(ip.get_image_path(expected)) as expected_image:
        assert actual_image.tobytes() == expected_image.tobytes()


@pytest.mark.parametrize("outcome,ready", [("success", True), ("failed", False)])
def test_stream_emits_emoji_only_for_successful_tool_result(monkeypatch, outcome, ready):
    from pydantic_ai import FunctionToolResultEvent
    from pydantic_ai.messages import ToolReturnPart

    from app import main

    class StubAgent:
        async def run_stream_events(self, prompt, **kwargs):
            yield FunctionToolResultEvent(
                ToolReturnPart(
                    "make_slack_ready",
                    "Slack-ready! Final image_id: abcdef123456",
                    outcome=outcome,
                )
            )

    monkeypatch.setattr(main, "emoji_agent", StubAgent())
    monkeypatch.setattr(main, "setup_otel", lambda **kwargs: None)
    with TestClient(app) as client:
        response = client.post(
            "/api/chat", json={"message": "Prepare it", "session_id": "tool-result-test"}
        )
    chunks = [
        json.loads(line[6:])
        for line in response.text.splitlines()
        if line.startswith("data: ")
    ]
    assert not any(chunk["type"] == "error" for chunk in chunks)
    results = [chunk for chunk in chunks if chunk["type"] == "emoji_ready"]
    assert bool(results) is ready
    if ready:
        assert results[0]["download_url"] == "/api/download/abcdef123456"
