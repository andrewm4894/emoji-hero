from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    model_config = {"env_file": ".env", "env_file_encoding": "utf-8"}

    # OpenRouter
    openrouter_api_key: str = ""
    openrouter_model: str = "openai/gpt-4.1"

    # Plano gateway — when set, LLM calls route through Plano (which proxies to
    # OpenRouter and computes Signals). Empty = call OpenRouter directly.
    # e.g. http://localhost:12000/v1
    plano_gateway_url: str = ""

    # Tavily
    tavily_api_key: str = ""

    # PostHog OTEL
    posthog_api_key: str = ""
    posthog_otel_endpoint: str = "https://us.i.posthog.com/i/v0/ai/otel"

    # App
    host: str = "0.0.0.0"
    port: int = 8000
    image_storage_dir: str = "/tmp/emoji-hero-images"
    max_image_age_seconds: int = 3600

    # Rate limits
    chat_rate_limit: str = "20/minute"
    download_rate_limit: str = "60/minute"


settings = Settings()
