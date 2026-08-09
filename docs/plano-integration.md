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

### Signals rendering — root cause & fix (resolved)

Initially Plano's signal spans did **not** surface in PostHog LLM Analytics despite the
bridge getting `2xx`. Root cause, confirmed in the PostHog source
(`rust/capture/src/otel/providers.rs`): the ingest only accepts spans whose attributes
match the prefixes `gen_ai.`, `ai.`, `traceloop.` / `llm.request.type`, or `pydantic_ai.`.
**Plain `llm.` is not accepted** — so Plano's `llm.*` + `signals.*` spans fail
`get_provider_raw()` and are dropped at `fan_out.rs` *before* any event is built (the `2xx`
is just the OTLP request being accepted). (Note: PostHog's OTEL docs *claim* `llm.*` is
accepted — a doc/code mismatch; see "Upstream fix" below.)

**Fix (implemented):** the bridge collector's `transform` processor maps Plano's `llm.*`
onto the `gen_ai.*` keys PostHog reads, so spans classify as `$ai_generation`. Since
`fan_out.rs` copies every span attribute through, `signals.*` then ride along as custom
properties for free. Verified: generations now appear in the dev project with `signals.*`
queryable, and Plano's 🚩 marker shows in the trace name on `severe` conversations.

```
signals.quality = "severe" / "neutral" / ...   (queryable property)
trace name: "POST /v1/chat/completions openrouter/openai/gpt-5.1-codex-mini 🚩"
```

### Upstream fix (PostHog)

The proper fix is upstream and **not Plano-specific** — draft PR
[PostHog/posthog#60064](https://github.com/PostHog/posthog/pull/60064). It adds an
`LLM_GENERIC` provider to `SUPPORTED_PROVIDERS` in `rust/capture/src/otel/providers.rs`,
but **narrowly**: it accepts `llm.*` spans only when they carry `llm.model` or `llm.usage.*`
(i.e. clearly LLM calls), not the whole `llm.*` namespace — because the ingestion was
deliberately scoped to avoid over-capturing non-AI traffic. Once that ships to Cloud, the
collector transform here becomes unnecessary. (Pending the LLM analytics team's call on
accepting `llm.*` vs. correcting the docs.)

### Caveat: Plano spans make poor LLM-Analytics *generations*

Getting the spans ingested ≠ getting a good result. Inspecting a Plano generation in the
dev project (e.g. `service.name = plano(llm)`, trace name ends in 🚩) shows the problem:

- **What maps:** `$ai_model`, `$ai_input_tokens`, `$ai_output_tokens`, `$ai_total_cost_usd`,
  `$ai_latency` (from the transform + token mapping).
- **What doesn't:** there is **no `$ai_input` / `$ai_output_choices`** — Plano never emits the
  message arrays, only a single truncated `llm.user_message_preview` (e.g. *"no!!! that is
  NOT what I wanted, fix it!"*). So the generation renders with **no conversation content**.
  Everything else (`llm.*`, `http.*`, `component`, `request_id`, `signals.*`) sits as raw
  unmapped properties. `$ai_model` is even the ugly gateway alias
  `openrouter/openai/gpt-5.1-codex-mini`.

Root reason: **Plano's telemetry isn't generation-shaped.** It's a proxy span (`llm.*` +
http + signals), not a `gen_ai`-convention LLM call with input/output messages. The
transform can *label* it `$ai_generation`, but can't manufacture IO that isn't in the span.

This also surfaces **duplicate generations per call**: the rich `emoji_agent` (pydantic-ai)
generation, this sparse `plano(llm)` one, *and* OpenRouter's native integration = up to
three generations for one LLM call. Plano's only unique contribution is the `signals.*`;
its generation content is strictly worse than the other two sources. So "make Plano a
generation" is the wrong frame — it clutters the Generations view to smuggle in properties.

### Options (undecided — parked)

1. **Unify via `traceparent`** (most correct) — propagate W3C trace context from the
   pydantic-ai HTTP client through to Plano so `signals.*` attach to the *same* trace as the
   rich `emoji_agent` generation (as a child span / properties / `$ai_metric`). One good
   trace, signals attached. Feasibility TBD (does pydantic-ai emit `traceparent`; does Plano
   forward it?).
2. **Downgrade Plano spans to `$ai_span`** (quick declutter) — stop classifying them as
   `$ai_generation` so they don't duplicate/clutter the Generations list; `signals.*` stay
   queryable as span properties. ~One-line change to the collector transform.
3. **Keep Plano out of LLM Analytics entirely** — the generation view is already well served
   by pydantic-ai + OpenRouter; surface signals via a dashboard on the `signals.*`
   properties or as metrics instead.

This also feeds back into [#60064](https://github.com/PostHog/posthog/pull/60064): auto-classifying
bare-`llm.*` proxy spans as `$ai_generation` produces exactly these contentless generations,
so the upstream call may be "accept the span but classify as `$ai_span`" rather than a
generation. Flag for the LLM analytics team.

### Resolved / verified along the way
- Signals **do** fire when provoked: a frustration+correction conversation produced
  `signals.quality = severe`, `quality_score = 0`, `interaction.disengagement.count = 4`
  (severity 2), `escalation.requested = true`, and the 🚩 marker. (Earlier "all neutral"
  was just benign test conversations.)
- `signals.*` are queryable as event properties in the dev project once the spans are
  accepted (the transform / the upstream PR).

### Open TODO
- Pick one of the three options above (or leave as-is for the dogfood).
- Minor: Plano generations get random-UUID `distinct_id`s (Plano doesn't propagate the
  PostHog distinct_id), so signals aren't tied to the app user. Would need Plano to forward
  a distinct_id (or set it on the span).
