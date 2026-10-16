"""The mid-stream error handler must split provider auth failures from transient ones.

A 401 or 403 from the model provider means our credential was rejected — a
configuration failure that no retry can fix until an operator rotates the key. It
must produce a distinct message and must NOT mint a fresh error tracking issue per
request. Every other mid-stream failure stays transient: the generic "try again"
message, captured for tracking.
"""

import json
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient
from pydantic_ai.exceptions import ModelHTTPError

from app.main import app


def _error_chunks(response) -> list[dict]:
    return [
        json.loads(line[6:])
        for line in response.text.splitlines()
        if line.startswith("data: ") and json.loads(line[6:]).get("type") == "error"
    ]


def _raise(exc):
    async def run_stream_events(*args, **kwargs):
        raise exc
        yield  # never reached — makes this an async generator

    return run_stream_events


@pytest.mark.parametrize("status_code", [401, 403])
def test_provider_auth_failure_is_config_error_and_not_captured(status_code):
    exc = ModelHTTPError(status_code=status_code, model_name="test")
    with patch("app.main.emoji_agent.run_stream_events", _raise(exc)), patch(
        "app.main.capture_exception"
    ) as capture:
        client = TestClient(app)
        response = client.post("/api/chat", json={"message": "hi", "session_id": "s"})

    errors = _error_chunks(response)
    assert len(errors) == 1
    assert "rotate" in errors[0]["content"].lower()
    # A rejected credential must not mint an error tracking issue per request.
    capture.assert_not_called()


def test_transient_failure_keeps_retry_message_and_is_captured():
    with patch(
        "app.main.emoji_agent.run_stream_events", _raise(RuntimeError("boom"))
    ), patch("app.main.capture_exception") as capture:
        client = TestClient(app)
        response = client.post("/api/chat", json={"message": "hi", "session_id": "s"})

    errors = _error_chunks(response)
    assert len(errors) == 1
    assert "try again" in errors[0]["content"].lower()
    capture.assert_called_once()
