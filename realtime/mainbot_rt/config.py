"""Environment-driven settings for the realtime agent (see realtime/.env.example)."""

from __future__ import annotations

import os
from dataclasses import dataclass, field


def _env(name: str, default: str = "") -> str:
    value = os.getenv(name)
    return value if value is not None and value != "" else default


def _env_float(name: str, default: float) -> float:
    try:
        return float(_env(name, str(default)))
    except ValueError:
        return default


def _env_int(name: str, default: int) -> int:
    try:
        return int(_env(name, str(default)))
    except ValueError:
        return default


def _env_bool(name: str, default: bool) -> bool:
    value = _env(name, "").lower()
    if not value:
        return default
    return value in {"1", "true", "yes", "on"}


def _env_list(name: str) -> list[str]:
    return [s.strip() for s in _env(name, "").split(",") if s.strip()]


@dataclass
class Settings:
    # --- the Node bot (shares MCP credentials, rules and instructions) ---
    mainbot_url: str = field(default_factory=lambda: _env("MAINBOT_URL", "http://localhost:3000").rstrip("/"))
    internal_api_key: str = field(default_factory=lambda: _env("INTERNAL_API_KEY"))

    # --- Claude ---
    model: str = field(default_factory=lambda: _env("RT_MODEL", "claude-sonnet-5"))
    effort: str = field(default_factory=lambda: _env("RT_EFFORT", "low"))
    max_tokens: int = field(default_factory=lambda: _env_int("RT_MAX_TOKENS", 1024))
    max_tool_steps: int = field(default_factory=lambda: _env_int("RT_MAX_TOOL_STEPS", 6))

    # --- speech ---
    stt_provider: str = field(default_factory=lambda: _env("STT_PROVIDER", "soniox"))
    soniox_stt_url: str = field(default_factory=lambda: _env("SONIOX_STT_URL", "wss://stt-rt.soniox.com/transcribe-websocket"))
    soniox_stt_model: str = field(default_factory=lambda: _env("SONIOX_STT_MODEL", "stt-rt-v5"))
    stt_language_hints: list[str] = field(default_factory=lambda: _env_list("STT_LANGUAGE_HINTS") or ["he", "en"])
    stt_context: str = field(default_factory=lambda: _env("STT_CONTEXT"))
    tts_provider: str = field(default_factory=lambda: _env("TTS_PROVIDER", "elevenlabs"))
    elevenlabs_voice_id: str = field(default_factory=lambda: _env("ELEVENLABS_VOICE_ID"))
    elevenlabs_model: str = field(default_factory=lambda: _env("ELEVENLABS_MODEL", "eleven_flash_v2_5"))
    soniox_tts_voice: str = field(default_factory=lambda: _env("SONIOX_TTS_VOICE", "Maya"))
    soniox_tts_model: str = field(default_factory=lambda: _env("SONIOX_TTS_MODEL", "tts-rt-v1-preview"))
    tts_language: str = field(default_factory=lambda: _env("TTS_LANGUAGE", "he"))

    # --- turn taking ---
    turn_detection: str = field(default_factory=lambda: _env("RT_TURN_DETECTION", "stt"))
    min_endpointing_delay: float = field(default_factory=lambda: _env_float("RT_MIN_ENDPOINTING_DELAY", 0.4))
    max_endpointing_delay: float = field(default_factory=lambda: _env_float("RT_MAX_ENDPOINTING_DELAY", 2.5))
    min_interruption_duration: float = field(default_factory=lambda: _env_float("RT_MIN_INTERRUPTION_DURATION", 0.5))
    min_interruption_words: int = field(default_factory=lambda: _env_int("RT_MIN_INTERRUPTION_WORDS", 0))
    preemptive_generation: bool = field(default_factory=lambda: _env_bool("RT_PREEMPTIVE_GENERATION", True))

    # --- safety ---
    allowed_phones: list[str] = field(default_factory=lambda: _env_list("ALLOWED_CALLER_PHONES"))
    confirm_writes: bool = field(default_factory=lambda: _env_bool("CONFIRM_WRITE_ACTIONS", True))
    blocked_tools: list[str] = field(default_factory=lambda: _env_list("BLOCKED_TOOLS"))

    # --- logs ---
    data_dir: str = field(default_factory=lambda: _env("RT_DATA_DIR", "./data"))
    greeting: str = field(default_factory=lambda: _env("RT_GREETING", "שלום, כאן העוזר החכם. במה אוכל לעזור?"))
    timezone: str = field(default_factory=lambda: _env("TIMEZONE", "Asia/Jerusalem"))


def load_settings() -> Settings:
    return Settings()
