# emoji-hero backend

FastAPI service that runs a pydantic-ai agent (via OpenRouter) to turn a chat request into a Slack-ready custom emoji, streaming progress back as SSE.

## works when

- typechecks
- pyproject.toml exists at root
- coherence.config.json exists at root

## why

The backend is the only place images are fetched, mutated and served, so the Slack-format invariants are enforced here rather than trusted from the frontend. Conversation history is in-memory by design — this is a dogfooding toy, not a product with durability requirements.
