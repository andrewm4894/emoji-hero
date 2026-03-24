import json
import os
from contextlib import asynccontextmanager
from pathlib import Path

from opentelemetry import trace

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
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
from app.analytics import setup_otel, shutdown_otel
from app.config import settings
from app.image_processing import get_image_path

# Rate limiter
limiter = Limiter(key_func=get_remote_address)

# Store conversation histories in memory (keyed by session_id)
conversations: dict[str, list] = {}

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
    message: str
    session_id: str = "default"


@app.post("/api/chat")
@limiter.limit(settings.chat_rate_limit)
async def chat(request: Request, body: ChatRequest):
    """Chat with the emoji agent. Streams all events as SSE."""
    history = conversations.get(body.session_id, [])

    # Read PostHog headers from frontend for session linking
    ph_distinct_id = request.headers.get("x-posthog-distinct-id", body.session_id)
    ph_session_id = request.headers.get("x-posthog-session-id", "")

    # Lazy-init OTEL with the user's distinct_id as user.id on the resource
    # (PostHog extracts distinct_id from resource attributes, not span attributes)
    setup_otel(user_id=ph_distinct_id)

    deps = EmojiDeps(distinct_id=ph_distinct_id)

    async def stream():
        # Set session IDs as span attributes — these flow through as event properties
        span = trace.get_current_span()
        if span.is_recording():
            if ph_session_id:
                span.set_attribute("$session_id", ph_session_id)
            span.set_attribute("$ai_session_id", body.session_id)

        accumulated = ""

        async for event in emoji_agent.run_stream_events(
            body.message,
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
                    chunk = json.dumps({"type": "text_delta", "content": event.part.content})
                    yield f"data: {chunk}\n\n"

            elif isinstance(event, PartDeltaEvent):
                if isinstance(event.delta, TextPartDelta) and event.delta.content_delta:
                    accumulated += event.delta.content_delta
                    chunk = json.dumps({"type": "text_delta", "content": event.delta.content_delta})
                    yield f"data: {chunk}\n\n"

            elif isinstance(event, FunctionToolCallEvent):
                chunk = json.dumps({
                    "type": "tool_call",
                    "tool": event.part.tool_name,
                    "args": event.part.args,
                })
                yield f"data: {chunk}\n\n"

            elif isinstance(event, FunctionToolResultEvent):
                chunk = json.dumps({"type": "tool_result", "tool": event.tool_call_id})
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
        return {"error": "Image not found"}, 404
    return FileResponse(path, media_type="image/png")


@app.get("/api/download/{image_id}")
@limiter.limit(settings.download_rate_limit)
async def download_image(request: Request, image_id: str):
    """Download a Slack-ready emoji image."""
    path = get_image_path(image_id)
    if not path:
        return {"error": "Image not found"}, 404
    return FileResponse(
        path,
        media_type="image/png",
        filename=f"emoji-{image_id}.png",
        headers={"Content-Disposition": f'attachment; filename="emoji-{image_id}.png"'},
    )


@app.get("/health")
async def health():
    return {"status": "ok", "version": "0.1.0"}


# Serve frontend static files (built React app)
FRONTEND_DIR = Path(
    os.environ.get("FRONTEND_DIR", str(Path(__file__).parent.parent.parent / "frontend" / "dist"))
)
if FRONTEND_DIR.exists():
    app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")
