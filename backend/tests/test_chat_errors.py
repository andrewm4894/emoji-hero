"""The mid-stream error handler must split provider auth failures from transient ones.

A 401 or 403 from the model provider means our credential was rejected — a
configuration failure that no retry can fix until an operator rotates the key. It
must produce a distinct message and land on one fixed-fingerprint error tracking
issue, so the outage reaches the inbox. Every other mid-stream failure stays
transient: the generic "try again" message, captured for tracking.
"""

import json
from contextlib import asynccontextmanager
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient
from pydantic_ai.exceptions import ModelHTTPError
from tavily.errors import InvalidAPIKeyError

from app.main import app


def _error_chunks(response) -> list[dict]:
    return [
        json.loads(line[6:])
        for line in response.text.splitlines()
        if line.startswith("data: ") and json.loads(line[6:]).get("type") == "error"
    ]


def _raise(exc):
    @asynccontextmanager
    async def run_stream_events(*args, **kwargs):
        raise exc
        yield  # never reached — makes this an async context manager

    return run_stream_events


@pytest.mark.parametrize(
    "exc,fingerprint",
    [
        (ModelHTTPError(status_code=401, model_name="test"), "model_provider"),
        (ModelHTTPError(status_code=403, model_name="test"), "model_provider"),
        (InvalidAPIKeyError("bad key"), "image_search"),
    ],
)
def test_provider_auth_failure_is_config_error_captured_on_one_issue(exc, fingerprint):
    with patch("app.main.emoji_agent.run_stream_events", _raise(exc)), patch(
        "app.main.capture_exception"
    ) as capture:
        client = TestClient(app)
        response = client.post("/api/chat", json={"message": "hi", "session_id": "s"})

    errors = _error_chunks(response)
    assert len(errors) == 1
    assert "rotate" in errors[0]["content"].lower()
    assert errors[0]["error_kind"] == "provider_auth"
    capture.assert_called_once()
    properties = capture.call_args.kwargs["properties"]
    assert properties["$exception_fingerprint"] == f"{fingerprint}-credential-rejected"


def test_transient_failure_keeps_retry_message_and_is_captured():
    with patch(
        "app.main.emoji_agent.run_stream_events", _raise(RuntimeError("boom"))
    ), patch("app.main.capture_exception") as capture:
        client = TestClient(app)
        response = client.post("/api/chat", json={"message": "hi", "session_id": "s"})

    errors = _error_chunks(response)
    assert len(errors) == 1
    assert "try again" in errors[0]["content"].lower()
    assert errors[0]["error_kind"] == "transient"
    capture.assert_called_once()


def test_unhandled_route_exception_is_captured():
    with (
        patch("app.main.edit_image", side_effect=RuntimeError("boom")),
        patch("app.main.capture_exception") as capture,
    ):
        client = TestClient(app, raise_server_exceptions=False)
        response = client.post("/api/edit", json={"image_id": "abcdef123456"})

    assert response.status_code == 500
    capture.assert_called_once()
    assert capture.call_args.kwargs["properties"]["path"] == "/api/edit"
