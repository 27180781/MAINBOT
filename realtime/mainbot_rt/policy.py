"""Read/write classification and the spoken-confirmation gate.

A port of src/mcp/tool-policy.ts from the Node bot so both agents make the same
decisions: reads run freely; a write is executed only when the model requests it
again after the caller heard what it is about to do and answered.
"""

from __future__ import annotations

import json
import re
import time
from dataclasses import dataclass, field
from typing import Any

READ_PATTERNS = [
    re.compile(r"^(get|list|search|find|read|fetch|check|view|show|describe|diagnose|explain|diff|export|download|count|whoami|lookup|query|verify_caller_id|validate|listening|queue|pipeline|revenue|inbox|daily|gamification|system_status|schema_version|render|preview|plan)_?", re.I),
    re.compile(r"(_summary|_report|_stats|_status|_history|_counts)$", re.I),
    re.compile(r"^(search|fetch)$", re.I),
]
WRITE_PATTERNS = [
    re.compile(r"^(create|add|update|delete|remove|send|set|manage|mark|merge|convert|record|run|execute|upload|transfer|hangup|toggle|bulk|cancel|schedule|replace|reset|rename|reorder|invite|disconnect|begin|start|edit|enable|disable|deploy|move|remix|initiate|import|learn|link|log|generate|request|write|clear|restore|rollback|fork|push|resolve|unresolve|archive|enqueue|charge|pay|refund)_?", re.I),
]
WRITE_VERBS = {"create", "add", "update", "delete", "remove", "send", "set", "manage", "mark", "merge", "convert", "record", "run", "execute", "upload", "transfer", "hangup", "toggle", "bulk", "cancel", "schedule", "replace", "reset", "rename", "reorder", "invite", "disconnect", "begin", "start", "edit", "enable", "disable", "deploy", "move", "remix", "initiate", "import", "learn", "link", "log", "generate", "request", "write", "clear", "restore", "rollback", "fork", "push", "resolve", "unresolve", "archive", "charge", "pay", "refund", "capture", "tokenize", "subscribe", "unsubscribe", "use", "login"}
READ_VERBS = {"get", "list", "search", "find", "read", "fetch", "check", "view", "show", "describe", "diagnose", "explain", "diff", "export", "download", "count", "whoami", "lookup", "query", "verify", "validate", "test", "catalog", "report", "summary", "stats", "status", "history", "counts", "preview", "render", "plan"}

CONFIRMATION_MESSAGE = (
    "CONFIRMATION REQUIRED: this action changes data or contacts someone, so it was NOT executed. "
    "Tell the caller exactly what you are about to do (who, what, which values) and ask for a clear yes. "
    "Only after the caller confirms in their next reply, call this tool again with the same arguments and it will run."
)


def classify_tool(name: str, annotations: dict[str, Any] | None = None) -> str:
    """Returns "read" or "write"."""
    ann = annotations or {}
    if ann.get("readOnlyHint") is True:
        return "read"
    if ann.get("destructiveHint") is True:
        return "write"
    base = name.split("__", 1)[1] if "__" in name else name
    if any(p.search(base) for p in WRITE_PATTERNS):
        return "write"
    if any(p.search(base) for p in READ_PATTERNS):
        return "read"
    tokens = [t for t in re.split(r"[_\-.]+", base.lower()) if t]
    if any(t in WRITE_VERBS for t in tokens):
        return "write"
    if any(t in READ_VERBS for t in tokens):
        return "read"
    return "write"


def has_server_side_confirmation(input_schema: dict[str, Any] | None) -> bool:
    props = (input_schema or {}).get("properties") or {}
    return any(k in props for k in ("confirm", "confirmation_token", "confirmationToken", "confirm_token"))


def is_blocked(name: str, patterns: list[str]) -> bool:
    for p in patterns:
        if not p:
            continue
        try:
            if re.search(p, name, re.I):
                return True
        except re.error:
            if p.lower() in name.lower():
                return True
    return False


def stable_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


@dataclass
class GateDecision:
    allowed: bool
    reason: str | None = None
    message: str | None = None


@dataclass
class _Pending:
    turn: int
    args: str
    at: float = field(default_factory=time.time)


class ConfirmationGate:
    """Per-conversation gate. `turn` increases once per caller utterance.

    A write requested in turn N with arguments A is executed only when the model asks
    for the same tool with the same arguments in turn N+1 (or N+2), i.e. after the
    caller answered the confirmation question.
    """

    def __init__(self, *, confirm_writes: bool = True, blocked_tools: list[str] | None = None, window_turns: int = 2) -> None:
        self.confirm_writes = confirm_writes
        self.blocked_tools = blocked_tools or []
        self.window = window_turns
        self._pending: dict[str, _Pending] = {}
        self.turn = 0

    def next_turn(self) -> None:
        self.turn += 1
        for key, pending in list(self._pending.items()):
            if self.turn - pending.turn > self.window:
                del self._pending[key]

    def check(self, name: str, arguments: dict[str, Any] | None, *, input_schema: dict[str, Any] | None = None, annotations: dict[str, Any] | None = None, server_read_only: bool = False) -> GateDecision:
        if is_blocked(name, self.blocked_tools):
            return GateDecision(False, "blocked", "This tool is blocked for the voice assistant by the administrator. Tell the caller it must be done from the computer.")
        if classify_tool(name, annotations) == "read":
            return GateDecision(True)
        if server_read_only:
            return GateDecision(False, "read_only_server", "This service is connected in read-only mode. Tell the caller the change must be made from the computer.")
        if not self.confirm_writes or has_server_side_confirmation(input_schema):
            return GateDecision(True)
        args_key = stable_json(arguments or {})
        prev = self._pending.get(name)
        if prev and prev.turn < self.turn and self.turn - prev.turn <= self.window:
            if prev.args == args_key:
                del self._pending[name]
                return GateDecision(True)
            # Same tool, different arguments: treat as a new request that needs its own confirmation.
            self._pending[name] = _Pending(self.turn, args_key)
            return GateDecision(False, "confirmation_required", CONFIRMATION_MESSAGE + " (The arguments changed since the caller's confirmation, so confirm the new values.)")
        if not prev or prev.turn != self.turn:
            self._pending[name] = _Pending(self.turn, args_key)
        return GateDecision(False, "confirmation_required", CONFIRMATION_MESSAGE)
