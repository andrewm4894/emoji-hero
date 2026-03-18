from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor

from pydantic_ai import Agent

from app.config import settings


def setup_otel() -> TracerProvider | None:
    """Configure OpenTelemetry to send traces to PostHog's OTEL endpoint."""
    if not settings.posthog_api_key:
        print("POSTHOG_API_KEY not set — OTEL tracing disabled")
        return None

    resource = Resource.create(
        {
            "service.name": "emoji-hero",
        }
    )

    exporter = OTLPSpanExporter(
        endpoint=settings.posthog_otel_endpoint,
        headers={"Authorization": f"Bearer {settings.posthog_api_key}"},
    )

    provider = TracerProvider(resource=resource)
    provider.add_span_processor(BatchSpanProcessor(exporter))
    trace.set_tracer_provider(provider)

    Agent.instrument_all()

    print(f"OTEL tracing enabled → {settings.posthog_otel_endpoint}")
    return provider
