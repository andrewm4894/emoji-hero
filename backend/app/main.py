import json
import logging
import os
import re
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from opentelemetry import trace
from pydantic import BaseModel, Field
from pydantic_ai import (
    AgentRunResultEvent,
    FunctionToolCallEvent,
    FunctionToolResultEvent,
    PartDeltaEvent,
    PartStartEvent,
    TextPartDelta,
)
from pydantic_ai.messages import TextPart
from slowapi import Limiter
from slowapi.util import get_remote_address

from app.agent import EmojiDeps, emoji_agent
from app.analytics import capture_exception, setup_otel, shutdown_otel
from app.config import settings
from app.editing import EditRequest, edit_image
from app.image_processing import IMAGE_METADATA, get_image_path

logger = logging.getLogger(__name__)

# Rate limiter
limiter = Limiter(key_func=get_remote_address)

# Store conversation histories in memory (keyed by session_id)
conversations: dict[str, list] = {}

# make_slack_ready's output format is defined in agent.py as
# "Slack-ready! Final image_id: {hex12} ..." — parse that known shape.
_SLACK_READY_ID_RE = re.compile(r"image_id:\s*([a-f0-9]{12})")


def _extract_image_id(content) -> str | None:
    if not isinstance(content, str):
        return None
    match = _SLACK_READY_ID_RE.search(content)
    return match.group(1) if match else None


@asynccontextmanager
async def lifespan(app: FastAPI):
    # OTEL is lazily initialized on first request so we can capture user.id
    yield
    shutdown_otel()


app = FastAPI(title="Emoji Hero", version="0.1.0", lifespan=lifespan)
app.state.limiter = limiter

# CORS for local dev
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class ChatRequest(BaseModel):
    message: str = Field(min_length=1, max_length=8000)
    session_id: str = "default"
    history: list[dict[str, str]] = Field(default_factory=list, max_length=60)


@app.post("/api/chat")
@limiter.limit(settings.chat_rate_limit)
async def chat(request: Request, body: ChatRequest):
    """Chat with the emoji agent. Streams all events as SSE."""
    history = [] if body.history else conversations.get(body.session_id, [])

    # Read PostHog headers from frontend for session linking
    ph_distinct_id = request.headers.get("x-posthog-distinct-id", body.session_id)
    ph_session_id = request.headers.get("x-posthog-session-id", "")

    # Lazy-init OTEL with the user's distinct_id as user.id on the resource
    # (PostHog extracts distinct_id from resource attributes, not span attributes)
    setup_otel(user_id=ph_distinct_id)

    deps = EmojiDeps(distinct_id=ph_distinct_id)
    prompt = body.message
    if body.history:
        transcript = "\n".join(
            f"{m.get('role', 'user')}: {m.get('content', '')[:8000]}"
            for m in body.history[-30:]
        )
        prompt = f"Previous conversation (context only):\n{transcript}\n\nCurrent request: {body.message}"

    async def stream():
        # Set session IDs as span attributes — these flow through as event properties
        span = trace.get_current_span()
        if span.is_recording():
            if ph_session_id:
                span.set_attribute("$session_id", ph_session_id)
            span.set_attribute("$ai_session_id", body.session_id)

        accumulated = ""

        try:
            async for event in emoji_agent.run_stream_events(
                prompt,
                deps=deps,
                message_history=history,
            ):
                if isinstance(event, AgentRunResultEvent):
                    conversations[body.session_id] = event.result.all_messages()
                    chunk = json.dumps({"type": "done", "content": accumulated})
                    yield f"data: {chunk}\n\n"

                elif isinstance(event, PartStartEvent):
                    if isinstance(event.part, TextPart) and event.part.content:
                        accumulated += event.part.content
                        chunk = json.dumps(
                            {"type": "text_delta", "content": event.part.content}
                        )
                        yield f"data: {chunk}\n\n"

                elif isinstance(event, PartDeltaEvent):
                    if (
                        isinstance(event.delta, TextPartDelta)
                        and event.delta.content_delta
                    ):
                        accumulated += event.delta.content_delta
                        chunk = json.dumps(
                            {"type": "text_delta", "content": event.delta.content_delta}
                        )
                        yield f"data: {chunk}\n\n"

                elif isinstance(event, FunctionToolCallEvent):
                    chunk = json.dumps(
                        {
                            "type": "tool_call",
                            "tool": event.part.tool_name,
                            "args": event.part.args_as_dict(),
                        }
                    )
                    yield f"data: {chunk}\n\n"

                elif isinstance(event, FunctionToolResultEvent):
                    chunk = json.dumps(
                        {"type": "tool_result", "tool": event.tool_call_id}
                    )
                    yield f"data: {chunk}\n\n"

                    if event.part.tool_name == "search_for_images":
                        try:
                            results = json.loads(event.part.content)
                            yield f"data: {json.dumps({'type': 'search_results', 'results': results})}\n\n"
                        except (ValueError, TypeError):
                            pass

                    if (
                        event.part.tool_name == "make_slack_ready"
                        and event.part.outcome == "success"
                    ):
                        image_id = _extract_image_id(event.part.content)
                        if image_id:
                            emoji_chunk = json.dumps(
                                {
                                    "type": "emoji_ready",
                                    **IMAGE_METADATA.get(image_id, {}),
                                    "image_id": image_id,
                                    "image_url": f"/api/images/{image_id}",
                                    "download_url": f"/api/download/{image_id}",
                                }
                            )
                            yield f"data: {emoji_chunk}\n\n"
        except Exception as exc:
            # By now the 200 status and SSE headers are already sent, so raising
            # would just truncate the stream and the client would see nothing —
            # emit a typed error chunk instead. Details stay in server logs.
            logger.exception("Agent run failed mid-stream")
            capture_exception(
                exc,
                distinct_id=ph_distinct_id,
                properties={"$session_id": ph_session_id} if ph_session_id else None,
            )
            chunk = json.dumps(
                {
                    "type": "error",
                    "content": "Something went wrong while generating a response. Please try again.",
                }
            )
            yield f"data: {chunk}\n\n"

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.get("/api/images/{image_id}")
async def get_image(image_id: str):
    """Get a processed image by ID."""
    path = get_image_path(image_id)
    if not path:
        raise HTTPException(status_code=404, detail="Image no longer available")
    return FileResponse(path, media_type="image/png")


@app.get("/api/download/{image_id}")
@limiter.limit(settings.download_rate_limit)
async def download_image(request: Request, image_id: str):
    """Download a Slack-ready emoji image."""
    path = get_image_path(image_id)
    if not path:
        raise HTTPException(status_code=404, detail="Image no longer available")
    return FileResponse(
        path,
        media_type="image/png",
        filename=f"emoji-{image_id}.png",
        headers={"Content-Disposition": f'attachment; filename="emoji-{image_id}.png"'},
    )


@app.post("/api/edit")
@limiter.limit(settings.chat_rate_limit)
async def edit(request: Request, body: EditRequest):
    try:
        return edit_image(body)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.get("/health")
async def health():
    return {"status": "ok", "version": "0.1.0"}


# Serve frontend static files (built React app)
FRONTEND_DIR = Path(
    os.environ.get(
        "FRONTEND_DIR", str(Path(__file__).parent.parent.parent / "frontend" / "dist")
    )
)
if FRONTEND_DIR.exists():
    app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")
