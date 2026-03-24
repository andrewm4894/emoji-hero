import os
import threading

from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor

from pydantic_ai import Agent

from app.config import settings

_provider: TracerProvider | None = None
_init_lock = threading.Lock()


def setup_otel(user_id: str | None = None) -> TracerProvider | None:
    """Configure OpenTelemetry to send traces to PostHog's OTEL endpoint.

    Called lazily on first request so we can set user.id from the frontend's
    distinct_id header. PostHog extracts distinct_id from the OTEL resource
    attribute ``user.id`` (see posthog/rust/capture/src/otel/identity.rs).
    """
    global _provider

    if _provider is not None:
        return _provider

    with _init_lock:
        # Double-check after acquiring lock
        if _provider is not None:
            return _provider

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

        resource_attrs: dict[str, str] = {
            "service.name": "emoji-hero",
        }
        if user_id:
            resource_attrs["user.id"] = user_id

        resource = Resource.create(resource_attrs)

        _provider = TracerProvider(resource=resource)
        _provider.add_span_processor(BatchSpanProcessor(exporter))
        trace.set_tracer_provider(_provider)

        Agent.instrument_all()

        print(f"OTEL tracing enabled → {settings.posthog_otel_endpoint} (user.id={user_id or 'not set'})")
        return _provider


def shutdown_otel() -> None:
    """Shutdown the OTEL provider if initialized."""
    if _provider:
        _provider.shutdown()
