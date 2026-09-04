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
