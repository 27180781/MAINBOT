"""MCP servers whose tools go through the confirmation gate.

LiveKit turns every MCP tool into a RawFunctionTool inside
``MCPServerHTTP._make_function_tool``. We keep that behaviour and wrap the call:
reads run as-is, writes are executed only after the caller confirmed (see policy.py).
Tool names are prefixed with the server name (``crm__search_contacts``) exactly like
the Node bot, so rules and blocked-tool patterns written for one agent apply to both.
"""

from __future__ import annotations

import logging
from typing import Any, Callable

from livekit.agents.llm import ToolError, function_tool
from livekit.agents.llm.mcp import MCPServerHTTP, MCPToolOptions, MCPTool

from .policy import ConfirmationGate, classify_tool

logger = logging.getLogger("mainbot.rt.mcp")

MAX_RESULT_CHARS = 12_000


class GatedMCPServerHTTP(MCPServerHTTP):
    def __init__(
        self,
        *,
        server_name: str,
        url: str,
        headers: dict[str, str],
        gate: ConfirmationGate,
        on_tool_call: Callable[[str, str, dict[str, Any]], None] | None = None,
        read_only: bool = False,
        client_session_timeout_seconds: float = 60,
    ) -> None:
        super().__init__(
            url,
            headers=headers,
            timeout=15,
            client_session_timeout_seconds=client_session_timeout_seconds,
            tool_result_resolver=_text_result_resolver,
        )
        self.server_name = server_name
        self._gate = gate
        self._on_tool_call = on_tool_call
        self._read_only = read_only

    def _make_function_tool(  # type: ignore[override]
        self,
        name: str,
        description: str | None,
        input_schema: dict[str, Any],
        meta: dict[str, Any] | None,
        *,
        options: MCPToolOptions,
    ) -> MCPTool:
        inner = super()._make_function_tool(name, description, input_schema, meta, options=options)
        full_name = _full_name(self.server_name, name)
        annotations = (meta or {}).get("annotations") if isinstance(meta, dict) else None
        gate = self._gate
        on_tool_call = self._on_tool_call
        read_only = self._read_only

        async def gated(raw_arguments: dict[str, Any]) -> Any:
            decision = gate.check(full_name, raw_arguments, input_schema=input_schema, annotations=annotations, server_read_only=read_only)
            if on_tool_call:
                on_tool_call(full_name, decision.reason or "allowed", raw_arguments)
            if not decision.allowed:
                logger.info("tool gated", extra={"tool": full_name, "reason": decision.reason})
                if decision.reason == "confirmation_required":
                    return decision.message
                raise ToolError(decision.message or "Not allowed.")
            result = await inner(raw_arguments)
            if isinstance(result, str) and len(result) > MAX_RESULT_CHARS:
                result = result[:MAX_RESULT_CHARS] + f"\n...[truncated {len(result) - MAX_RESULT_CHARS} chars - ask for a narrower query if you need more]"
            return result

        kind = classify_tool(full_name, annotations)
        raw_schema = {
            "name": full_name,
            "description": f"[{kind}] ({self.server_name}) {description or name}"[:2000],
            "parameters": input_schema,
        }
        return function_tool(gated, raw_schema=raw_schema, flags=options["flags"], on_duplicate=options["on_duplicate"], duplicate_scope=options["duplicate_scope"])


def _full_name(server: str, tool: str) -> str:
    import hashlib
    import re

    raw = re.sub(r"[^A-Za-z0-9_-]", "_", f"{server}__{tool}")
    if len(raw) <= 64:
        return raw
    digest = hashlib.sha1(raw.encode()).hexdigest()[:6]
    return f"{raw[:57]}_{digest}"


def _text_result_resolver(ctx: Any) -> str:
    """Flattens an MCP CallToolResult into plain text for the LLM (images are omitted)."""
    parts: list[str] = []
    for item in ctx.result.content:
        item_type = getattr(item, "type", "")
        if item_type == "text":
            parts.append(str(getattr(item, "text", "")))
        elif item_type in ("image", "audio"):
            parts.append(f"[{item_type} omitted]")
        elif item_type == "resource":
            resource = getattr(item, "resource", None)
            parts.append(str(getattr(resource, "text", "") or f"[resource {getattr(resource, 'uri', '')}]"))
        else:
            parts.append(str(item))
    text = "\n".join(p for p in parts if p).strip()
    if not text:
        structured = getattr(ctx.result, "structuredContent", None)
        if structured:
            import json

            text = json.dumps(structured, ensure_ascii=False)
    return text or "(empty result)"
