from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    env: str = "development"
    port: int = 8000
    log_level: str = "info"
    cors_origins: str = (
        "http://localhost:5173,"
        "http://localhost:5174,"
        "https://hyenem.github.io"
    )

    # ---- OpenAI ----
    # When OPENAI_API_KEY is missing/empty the server runs the deterministic
    # mock pipeline from Sprint 1 — that's what keeps pytest passing in CI.
    openai_api_key: str = ""
    openai_stt_model: str = "whisper-1"
    openai_llm_model: str = "gpt-4o-mini"
    openai_tts_model: str = "tts-1"
    openai_tts_voice: str = "alloy"

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    @property
    def has_openai(self) -> bool:
        return bool(self.openai_api_key and self.openai_api_key.startswith("sk-"))


@lru_cache
def get_settings() -> Settings:
    return Settings()
