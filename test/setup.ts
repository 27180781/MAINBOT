/**
 * Runs before every test file: src/config.ts bakes environment variables into its defaults
 * at import time, so a developer's or operator's real .env (PIN, TTS voice, greeting, phone
 * list, model...) must not leak into the suite. dotenv itself is skipped under VITEST.
 */
const BOT_ENV = [
  "BOT_MODEL", "BOT_EFFORT", "BOT_MAX_TOKENS", "BOT_FALLBACKS", "TOOL_SEARCH", "CONFIRM_WRITE_ACTIONS", "TTS_VOICE", "GREETING", "BOT_PIN",
  "ALLOWED_CALLER_PHONES", "STT_MAX_SECONDS", "PBX_LONG_POLL_MS", "PBX_FIRST_POLL_MS", "AGENT_TIMEOUT_MS", "TOOL_TIMEOUT_MS", "SESSION_TTL_MS",
  "MAX_TOOL_RESULT_CHARS", "WEBHOOK_SECRET", "ADMIN_USER", "ADMIN_PASSWORD", "DATA_DIR", "MCP_CONFIG_PATH", "MCP_AUTH_DIR", "INSTRUCTIONS_PATH",
  "PUBLIC_BASE_URL", "TIMEZONE", "PORT", "HOST", "TRUST_PROXY", "CHAT_API_KEY", "CHAT_CORS_ORIGINS", "CHAT_SESSION_TTL_MS", "INTERNAL_API_KEY",
  "OWNER_PHONE", "OWNER_EMAIL", "MCP_OAUTH_CALLBACK_PORT", "LOG_PRETTY",
];
for (const name of BOT_ENV) delete process.env[name];
process.env.LOG_LEVEL = "silent";
