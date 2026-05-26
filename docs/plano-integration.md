# Plano integration (dogfooding)

Routing Emoji Hero's LLM calls through [Plano](https://github.com/katanemo/plano) — an
AI-native proxy / data plane — to dogfood its **Signals™** (model-free behavioral
indicators) and stream the enriched telemetry into a PostHog dev project over OTEL.

> Status: **exploratory**, on branch `explore/plano-integration`. The integration is
> opt-in (off by default) and fully reversible via a single env var.

## Why

Plano sits out-of-process between the agent and the LLM provider and, with tracing on,
computes [Signals](https://docs.planoai.dev/concepts/signals.html) on each turn
(interaction quality, tool-failure/loop detection, satisfaction/disengagement, etc.) and
emits them as OpenTelemetry span attributes — no app code changes required. Emoji Hero is
a good testbed: multi-turn chat with heavy tool use exercises both interaction and
execution signals.

## Architecture

```
Emoji Hero backend (pydantic-ai)
   │  OpenAI chat-completions (streaming + tool calls)
   ▼
Plano gateway  :12000   ──upstream──▶  OpenRouter   (provider_interface: openrouter)
   │  computes Signals™, emits OTLP/gRPC
   ▼
bridge OTEL collector  :4319   ──OTLP/HTTP + Bearer──▶  PostHog (dev project)  /i/v0/ai/otel
```

- The backend only flips its OpenAI `base_url` to Plano when `PLANO_GATEWAY_URL` is set;
  otherwise it calls OpenRouter directly (unchanged behaviour).
- Plano emits traces over **OTLP/gRPC** only. PostHog's OTEL endpoint is **OTLP/HTTP +
  `Authorization: Bearer <project_key>`**. The bridge collector
  (`backend/otel-collector-plano.yaml`) converts gRPC→HTTP and adds the auth header. It is
  intentionally **separate** from any local PostHog dev collector so Plano traffic stays
  isolated.

## Files

| File | Purpose |
|---|---|
| `backend/plano_config.yaml` | Plano gateway config: OpenRouter provider + `tracing.random_sampling: 100`, exports to the bridge on `:4319`. |
| `backend/otel-collector-plano.yaml` | Dedicated OTEL collector: receives Plano OTLP/gRPC on `:4319`, forwards to PostHog (env-driven) + a debug log. |
| `backend/app/config.py` | Adds `plano_gateway_url` setting. |
| `backend/app/agent.py` | When `plano_gateway_url` is set, points the OpenAI client at Plano and prefixes the model with `openrouter/`. |
| `backend/.env.example` | Documents `PLANO_GATEWAY_URL`. |

## Running it locally

```bash
# 1. Install the Plano CLI (native mode; first run downloads Envoy + brightstaff to ~/.plano)
uv tool install planoai==0.4.22

# 2. Start the gateway (reads OPENROUTER_API_KEY from backend/.env automatically)
planoai up backend/plano_config.yaml

# 3. Start the bridge collector -> PostHog dev project
#    POSTHOG_OTEL_ENDPOINT + POSTHOG_API_KEY come from backend/.env, or pass with -e
docker run -d --name plano-otel-bridge -p 4319:4319 \
  --env-file backend/.env \
  -v "$PWD/backend/otel-collector-plano.yaml:/etc/otelcol-contrib/config.yaml" \
  otel/opentelemetry-collector-contrib:0.142.0 --config=/etc/otelcol-contrib/config.yaml

# 4. Point the backend at Plano, then run it
echo 'PLANO_GATEWAY_URL=http://localhost:12000/v1' >> backend/.env
make backend
```

To disable: remove/comment `PLANO_GATEWAY_URL`, `planoai down`, `docker rm -f plano-otel-bridge`.

## Gotchas learned

- **Model naming.** Plano selects the OpenRouter provider via an `openrouter/` model
  prefix and forwards the remainder upstream, so the gateway model is
  `openrouter/openai/gpt-5.1-codex-mini`. Do **not** also set `provider_interface` when the
  prefix is already a supported provider (validation error). `openrouter` requires
  `base_url`.
- **Non-streaming returns an empty body.** OpenRouter sends leading `\n` keepalive bytes
  that break Plano's *buffered* JSON parser (`EOF while parsing a value at line 3`).
  **Streaming works fine** — Emoji Hero always streams, so it's unaffected. Avoid hitting
  Plano with non-streaming requests.
- **Trace export endpoint.** `tracing.opentracing_grpc_endpoint` in the config overrides
  the default `:4317` (resolution order: config > `OTEL_TRACING_GRPC_ENDPOINT` env >
  default). Must be scheme+host only, no path.

## What lands in PostHog (and what doesn't)

PostHog's [OTEL ingest](https://posthog.com/docs/ai-observability/installation/opentelemetry)
accepts the `gen_ai.*`, `llm.*`, `ai.*`, and `traceloop.*` namespaces; unmapped attributes
pass through as custom event properties.

When dogfooding against the dev project (148051), **three** telemetry sources are visible —
worth knowing how to tell them apart:

| Source | How to spot it | Has Signals? | Content |
|---|---|---|---|
| Emoji Hero's own pydantic-ai OTEL (`analytics.py`) | `service.name = emoji-hero`, trace name `emoji_agent` | no | full, rich (incl. rendered emoji images) |
| OpenRouter's **native** PostHog integration | `openrouter_source`, `openrouter_api_key_name: emoji-hero` | no | full input/output |
| **Plano OTEL bridge** (this work) | `service.name = plano(llm)` / `plano(routing)` | **yes** (`signals.*`) | truncated preview |

Plano emits on its LLM span: `llm.model`, `llm.usage.{prompt,completion,total,cached_input,reasoning}_tokens`,
`llm.time_to_first_token`, `llm.tools`, `llm.user_message_preview`, and
`signals.{quality,quality_score,efficiency_score,turn_count}` (layered interaction/execution
signals only emit when they fire).

### Open findings / TODO

- ⚠️ **Plano's signal spans are not surfacing in PostHog LLM Analytics yet.** The bridge
  forwards them and PostHog returns `2xx`, but a query for `signals.quality IS NOT NULL`
  (or `service.name LIKE '%plano%'`) returns zero generations. Likely because Plano's spans
  carry no `gen_ai.operation.name`, so PostHog doesn't classify them as `$ai_generation`.
  Next: confirm whether they land as `$ai_span` / raw events, and whether a small collector
  transform (set `gen_ai.operation.name`, promote the message preview) is needed.
- In test conversations, interaction signals stayed `neutral` (`quality_score 50`) — only
  top-level signals populated. Need conversations that deliberately trip satisfaction /
  disengagement / loops to see the richer signal set and the 🚩 flag.
- Decide whether to keep all three telemetry sources or consolidate (e.g. drop the app's
  own OTEL and rely on Plano, or propagate W3C `traceparent` so Plano's signals attach to
  the same trace as the `emoji_agent` run).
