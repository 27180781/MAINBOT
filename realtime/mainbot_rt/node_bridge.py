"""Talks to the Node bot's internal API: shared MCP credentials, rules and instructions."""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any

import aiohttp

logger = logging.getLogger("mainbot.rt.bridge")


@dataclass
class McpServerInfo:
    name: str
    label: str
    url: str
    state: str
    headers: dict[str, str]
    expires_in_seconds: int | None
    always_load: list[str] = field(default_factory=list)


@dataclass
class AgentConfig:
    servers: list[McpServerInfo]
    rules: list[dict[str, Any]]
    instructions: str
    extra_instructions: str
    allowed_phones: list[str]
    blocked_tools: list[str]
    confirm_writes: bool
    model: str

    def rules_text(self) -> str:
        return "\n".join(f"{r.get('id')}. {r.get('text')}" for r in self.rules if r.get("text"))


class NodeBridge:
    def __init__(self, base_url: str, api_key: str, *, timeout_s: float = 20.0) -> None:
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.timeout = aiohttp.ClientTimeout(total=timeout_s)

    @property
    def enabled(self) -> bool:
        return bool(self.base_url and len(self.api_key) >= 16)

    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"}

    async def fetch_config(self) -> AgentConfig | None:
        if not self.enabled:
            logger.warning("MAINBOT_URL / INTERNAL_API_KEY not set - running without MCP servers and rules")
            return None
        try:
            async with aiohttp.ClientSession(timeout=self.timeout) as session:
                async with session.get(f"{self.base_url}/internal/agent-config", headers=self._headers()) as res:
                    if res.status != 200:
                        logger.error("agent-config request failed: HTTP %s %s", res.status, (await res.text())[:300])
                        return None
                    data = await res.json()
        except Exception as err:  # noqa: BLE001 - startup must not crash on a flaky bridge
            logger.error("agent-config request failed: %s", err)
            return None
        always = data.get("alwaysLoad") or {}
        servers = [
            McpServerInfo(
                name=s["name"],
                label=s.get("label") or s["name"],
                url=s["url"],
                state=s.get("state", "unknown"),
                headers=dict(s.get("headers") or {}),
                expires_in_seconds=s.get("expiresInSeconds"),
                always_load=list(always.get(s["name"], [])),
            )
            for s in data.get("servers", [])
        ]
        return AgentConfig(
            servers=servers,
            rules=list(data.get("rules") or []),
            instructions=str(data.get("instructions") or ""),
            extra_instructions=str(data.get("extraInstructions") or ""),
            allowed_phones=list(data.get("allowedPhones") or []),
            blocked_tools=list(data.get("blockedTools") or []),
            confirm_writes=bool(data.get("confirmWrites", True)),
            model=str(data.get("model") or ""),
        )

    async def add_rule(self, text: str, source: str) -> dict[str, Any]:
        if not self.enabled:
            raise RuntimeError("the Node bot bridge is not configured (MAINBOT_URL / INTERNAL_API_KEY)")
        async with aiohttp.ClientSession(timeout=self.timeout) as session:
            async with session.post(f"{self.base_url}/internal/rules", headers=self._headers(), json={"text": text, "source": source}) as res:
                data = await res.json()
                if res.status != 200 or not data.get("ok"):
                    raise RuntimeError(str(data.get("error") or f"HTTP {res.status}"))
                return dict(data["rule"])
