# emoji-hero — map for agents

> Generated from the spec tree by the coherence harness. Do not edit by hand.

FastAPI service that runs a pydantic-ai agent (via OpenRouter) to turn a chat request into a Slack-ready custom emoji, streaming progress back as SSE.

## Components

### emoji-hero backend  `.`
FastAPI service that runs a pydantic-ai agent (via OpenRouter) to turn a chat request into a Slack-ready custom emoji, streaming progress back as SSE.

_why:_ The backend is the only place images are fetched, mutated and served, so the Slack-format invariants are enforced here rather than trusted from the frontend. Conversation history is in-memory by design — this is a dogfooding toy, not a product with durability requirements.

_works when:_
- typechecks
- pyproject.toml exists at root
- coherence.config.json exists at root

_files:_ `conftest.py`, `test_image_processing.py`

### app  `app`
The agent, its tools, and the HTTP surface. Every image passes through `image_processing` and is addressed by an immutable 12-hex id; only `prepare_for_slack` may mint the artifact the user downloads as an emoji.

_why:_ Image ids are immutable by convention (each of download / text / crop / slack-ready mints a fresh 12-hex id and never overwrites its source) — that is a tier-3 convention today, anchored only by `test_prepare_for_slack_returns_new_immutable_id`, and a candidate for promotion to a single `_new_id` chokepoint. Slack rejects custom emoji that exceed 128KB or 128px, and a user who downloads a broken emoji gets no error from us — so the limit is enforced in code with a fallback ladder (optimize → quantize → shrink) and tested with incompressible noise, the worst case for PNG.

_works when:_
- boundary "every emoji leaving the service is a PNG no larger than 128x128 and under 128KB" at prepare_for_slack via test "test_slack_boundary_holds_for_every_admitted_format"
- passes test "test_prepare_for_slack_fits_dimensions"
- passes test "test_prepare_for_slack_pads_non_square_to_square"
- passes test "test_prepare_for_slack_returns_new_immutable_id"
- passes test "test_get_image_path_unknown_id_is_none"
- main.py imports app.agent
- agent.py imports app.image_processing

_files:_ `__init__.py`, `agent.py`, `analytics.py`, `config.py`, `image_processing.py`, `main.py`, `search.py`

## Structure

```
emoji-hero/
├─ app/  ●
│  ├─ __init__.py
│  ├─ agent.py
│  ├─ analytics.py
│  ├─ config.py
│  ├─ image_processing.py
│  ├─ main.py
│  └─ search.py
└─ tests/
   ├─ conftest.py
   └─ test_image_processing.py
```

