# Emoji Hero

Find and customize Slack emoji through a conversational React interface, backed by a FastAPI agent.

## Run locally

Requires Node.js, npm, and uv.

1. Run `make install` to install dependencies.
2. Copy `backend/.env.example` to `backend/.env` if it does not already exist. Set a valid `OPENROUTER_API_KEY` and `TAVILY_API_KEY` for chat and image search. PostHog settings are optional.
3. Run `make dev` from the repository root.
4. Open http://localhost:5188. The backend runs at http://localhost:8787; Vite proxies `/api` requests to it.

If chat returns an error, check the backend terminal. An OpenRouter 401 means the configured API key needs replacing. Restart the backend after updating `backend/.env`.

## Frontend checks

Run `npm run build` and `npm run lint` from `frontend/`.

## Editing and conversations

Search results are downloaded and decoded before they appear in a clickable grid.
Use **Hide result** for irrelevant images or a placeholder returned by the source.
Select an image to prepare it for Slack, then use **Crop** or **Edit text** to adjust
it. The result shows an enlarged preview and a 20px reaction preview.

The current conversation is saved in this browser. **New emoji** starts a separate
conversation. Image files are stored on the server and may disappear after a
server restart or deployment; unavailable images can be replaced with a new search.

Backend checks: run `uv run python -m pytest -q` and `uv run ruff check app/ tests/`
from `backend/`.
