import os

from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor

from pydantic_ai import Agent

from app.config import settings


def setup_otel() -> TracerProvider | None:
    """Configure OpenTelemetry to send traces to PostHog's OTEL endpoint.

    Follows the pattern from posthog/llm-analytics-apps pydantic_ai_otel.py:
    set env vars first, then create OTLPSpanExporter() with no args.
    """
    if not settings.posthog_api_key:
        print("POSTHOG_API_KEY not set — OTEL tracing disabled")
        return None

    # Configure OTLP exporter via env vars
    # Use TRACES_ENDPOINT to avoid automatic /v1/traces suffix
    os.environ["OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"] = settings.posthog_otel_endpoint
    os.environ["OTEL_EXPORTER_OTLP_HEADERS"] = (
        f"Authorization=Bearer {settings.posthog_api_key}"
    )

    exporter = OTLPSpanExporter()

    resource = Resource.create(
        {
            "service.name": "emoji-hero",
        }
    )

    provider = TracerProvider(resource=resource)
    provider.add_span_processor(BatchSpanProcessor(exporter))
    trace.set_tracer_provider(provider)

    Agent.instrument_all()

    print(f"OTEL tracing enabled → {settings.posthog_otel_endpoint}")
    return provider
