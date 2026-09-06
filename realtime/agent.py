"""MAINBOT realtime voice agent - a LiveKit Agents worker.

Pipeline: Soniox STT (Hebrew, streaming) -> Claude (streaming, tools) -> ElevenLabs / Soniox TTS,
with VAD, end-of-turn detection and barge-in. The tools are the owner's own MCP servers,
reached with the credentials the Node bot already holds (GET /internal/agent-config), and
every write goes through the same spoken-confirmation gate as the phone bot.

Run locally:   python agent.py dev
Production:    python agent.py start      (see run.sh / Dockerfile)
"""

from __future__ import annotations

import asyncio
import logging
import random
import re
from typing import Any

from dotenv import load_dotenv
from livekit import rtc
from livekit.agents import (
    Agent,
    AgentServer,
    AgentSession,
    JobContext,
    JobProcess,
    RunContext,
    cli,
    function_tool,
    get_job_context,
    llm,
    room_io,
)
from livekit.agents.types import DEFAULT_API_CONNECT_OPTIONS, NOT_GIVEN, NotGivenOr
from livekit.agents.utils import is_given
from livekit.plugins import anthropic, elevenlabs, silero, soniox

from mainbot_rt.config import Settings, load_settings
from mainbot_rt.gated_mcp import GatedMCPServerHTTP
from mainbot_rt.latency import SessionLog
from mainbot_rt.node_bridge import AgentConfig, McpServerInfo, NodeBridge
from mainbot_rt.policy import ConfirmationGate
from mainbot_rt.prompt import build_instructions, call_context

try:  # LiveKit Cloud only; optional
    from livekit.plugins import noise_cancellation
except Exception:  # noqa: BLE001
    noise_cancellation = None  # type: ignore[assignment]

load_dotenv()
logger = logging.getLogger("mainbot.rt")
settings: Settings = load_settings()

FILLERS = ["רגע, בודק.", "שנייה, מסתכל.", "בודק את זה."]


# --------------------------------------------------------------------------- #
# Claude                                                                       #
# --------------------------------------------------------------------------- #

def model_efforts(model: str) -> list[str]:
    """Effort levels the model accepts (empty = do not send output_config.effort)."""
    m = model.lower()
    if re.match(r"^claude-(opus|fable|mythos)-5", m) or re.match(r"^claude-sonnet-5", m) or re.match(r"^claude-(opus|sonnet)-4-[78]", m):
        return ["low", "medium", "high", "xhigh", "max"]
    if re.match(r"^claude-(opus|sonnet)-4-6", m):
        return ["low", "medium", "high", "max"]
    return []


class ClaudeLLM(anthropic.LLM):
    """The Anthropic plugin with the request shape a realtime voice agent wants.

    The plugin does not carry thinking blocks between turns, so thinking is disabled
    explicitly (Sonnet 5 / Opus 5 would otherwise run adaptive thinking by default) and
    the effort level is set low for latency. Prompt caching covers system + tools.
    """

    def __init__(self, *, model: str, effort: str, max_tokens: int) -> None:
        super().__init__(model=model, max_tokens=max_tokens, caching="ephemeral")
        efforts = model_efforts(model)
        self._effort = effort if effort in efforts else (efforts[0] if efforts else None)
        self._disable_thinking = not model.lower().startswith("claude-haiku")

    def chat(  # type: ignore[override]
        self,
        *,
        chat_ctx: llm.ChatContext,
        tools: list[llm.Tool] | None = None,
        conn_options=DEFAULT_API_CONNECT_OPTIONS,
        parallel_tool_calls: NotGivenOr[bool] = NOT_GIVEN,
        tool_choice: NotGivenOr[llm.ToolChoice] = NOT_GIVEN,
        extra_kwargs: NotGivenOr[dict[str, Any]] = NOT_GIVEN,
    ) -> llm.LLMStream:
        extra: dict[str, Any] = dict(extra_kwargs) if is_given(extra_kwargs) else {}
        if self._disable_thinking:
            extra.setdefault("thinking", {"type": "disabled"})
        if self._effort:
            extra.setdefault("output_config", {"effort": self._effort})
        return super().chat(
            chat_ctx=chat_ctx,
            tools=tools,
            conn_options=conn_options,
            parallel_tool_calls=parallel_tool_calls,
            tool_choice=tool_choice,
            extra_kwargs=extra,
        )


# --------------------------------------------------------------------------- #
# Speech providers                                                             #
# --------------------------------------------------------------------------- #

def make_stt(s: Settings, *, telephony: bool):
    if s.stt_provider != "soniox":
        raise RuntimeError(f"unsupported STT_PROVIDER={s.stt_provider}")
    params = soniox.STTOptions(
        model=s.soniox_stt_model,
        language_hints=s.stt_language_hints,
        context=s.stt_context or None,
        # Endpoint detection = our end-of-turn signal (turn_detection="stt").
        max_endpoint_delay_ms=int(min(3000, max(500, s.max_endpointing_delay * 1000))),
        endpoint_latency_adjustment_level=2 if not telephony else 1,
    )
    return soniox.STT(params=params, base_url=s.soniox_stt_url)


def make_tts(s: Settings):
    if s.tts_provider == "soniox":
        return soniox.TTS(model=s.soniox_tts_model, language=s.tts_language, voice=s.soniox_tts_voice)
    if not s.elevenlabs_voice_id:
        raise RuntimeError("ELEVENLABS_VOICE_ID is required for TTS_PROVIDER=elevenlabs")
    return elevenlabs.TTS(voice_id=s.elevenlabs_voice_id, model=s.elevenlabs_model, language=s.tts_language)


# --------------------------------------------------------------------------- #
# The agent                                                                    #
# --------------------------------------------------------------------------- #

class MainbotAgent(Agent):
    def __init__(self, *, instructions: str, mcp_servers: list[GatedMCPServerHTTP], gate: ConfirmationGate, bridge: NodeBridge, phone: str, greeting: str) -> None:
        super().__init__(instructions=instructions, mcp_servers=list(mcp_servers))
        self._gate = gate
        self._bridge = bridge
        self._phone = phone
        self._greeting = greeting

    async def on_enter(self) -> None:
        # A fixed greeting spoken directly: no LLM round-trip before the first word.
        self.session.say(self._greeting, allow_interruptions=True)

    async def llm_node(self, chat_ctx: llm.ChatContext, tools: list[llm.Tool], model_settings):  # type: ignore[override]
        """Default LLM node plus a safety net: if Claude starts with a tool call and said
        nothing first, speak a short filler so the caller never hears silence while the
        tool runs (the prompt asks for a sentence before every tool call; this covers
        the times it forgets)."""
        saw_text = False
        filler_done = False
        async for chunk in Agent.default.llm_node(self, chat_ctx, tools, model_settings):
            if isinstance(chunk, llm.ChatChunk) and chunk.delta is not None:
                if chunk.delta.content:
                    saw_text = True
                if chunk.delta.tool_calls and not saw_text and not filler_done:
                    filler_done = True
                    yield random.choice(FILLERS) + " "
            yield chunk

    @function_tool()
    async def end_call(self, ctx: RunContext) -> str:
        """Ends the call after your current sentence is spoken. Call it when the caller says goodbye or that they are done, in the same reply as your farewell."""
        await ctx.wait_for_playout()
        job = get_job_context()
        await job.delete_room()
        return "The call has ended."

    @function_tool()
    async def add_rule(self, ctx: RunContext, text: str) -> str:
        """Saves a new permanent rule for yourself (the assistant's standing skill), in Hebrew, one or two sentences, general enough for future calls. Use it when the owner says 'מעכשיו', 'תזכור ש', 'תמיד', 'תכתוב לעצמך כלל'. Read the exact text back and get a yes before saving. Never store passwords or customer details.

        Args:
            text: The rule text in Hebrew.
        """
        decision = self._gate.check("add_rule", {"text": text}, annotations={"destructiveHint": True})
        if not decision.allowed:
            return decision.message or "Not allowed."
        try:
            rule = await self._bridge.add_rule(text, f"realtime:{self._phone}")
        except Exception as err:  # noqa: BLE001
            return f"Rule error: {err}"
        return f"נשמר ככלל {rule.get('id')}: {rule.get('text')}. הכלל ייכנס לתוקף מהשיחה הבאה."


# --------------------------------------------------------------------------- #
# Worker                                                                       #
# --------------------------------------------------------------------------- #

def prewarm(proc: JobProcess) -> None:
    proc.userdata["vad"] = silero.VAD.load(min_silence_duration=0.35, activation_threshold=0.5)


server = AgentServer(setup_fnc=prewarm)


def normalize_phone(raw: str) -> str:
    digits = re.sub(r"\D", "", raw or "")
    if digits.startswith("972"):
        digits = "0" + digits[3:]
    if len(digits) == 9 and not digits.startswith("0"):
        digits = "0" + digits
    return digits


def phone_allowed(phone: str, allowed: list[str]) -> bool:
    if not allowed:
        return False
    if "*" in allowed:
        return True
    return normalize_phone(phone) in {normalize_phone(a) for a in allowed}


def usable_servers(config: AgentConfig | None) -> list[McpServerInfo]:
    if not config:
        return []
    return [s for s in config.servers if s.state == "connected"]


@server.rtc_session()
async def entrypoint(ctx: JobContext) -> None:
    await ctx.connect()
    participant = await ctx.wait_for_participant()
    is_sip = participant.kind == rtc.ParticipantKind.PARTICIPANT_KIND_SIP
    phone = participant.attributes.get("sip.phoneNumber") or participant.attributes.get("mainbot.phone") or participant.identity
    channel = "שיחה קולית בזמן אמת (טלפון)" if is_sip else "שיחה קולית בזמן אמת (דפדפן)"
    logger.info("session start", extra={"room": ctx.room.name, "phone": phone, "sip": is_sip})

    bridge = NodeBridge(settings.mainbot_url, settings.internal_api_key)
    config = await bridge.fetch_config()
    allowed = settings.allowed_phones or (config.allowed_phones if config else [])
    log = SessionLog(settings.data_dir, ctx.room.name, phone)

    gate = ConfirmationGate(
        confirm_writes=config.confirm_writes if config else settings.confirm_writes,
        blocked_tools=(config.blocked_tools if config else []) + settings.blocked_tools,
    )
    servers = usable_servers(config)
    mcp_servers = [
        GatedMCPServerHTTP(server_name=s.name, url=s.url, headers=s.headers, gate=gate, on_tool_call=log.on_tool)
        for s in servers
    ]
    instructions = build_instructions(config, servers, context=call_context(phone=phone, timezone=settings.timezone, channel=channel))

    session: AgentSession = AgentSession(
        stt=make_stt(settings, telephony=is_sip),
        llm=ClaudeLLM(model=settings.model, effort=settings.effort, max_tokens=settings.max_tokens),
        tts=make_tts(settings),
        vad=ctx.proc.userdata["vad"],
        turn_handling={
            "turn_detection": settings.turn_detection,
            "endpointing": {"mode": "fixed", "min_delay": settings.min_endpointing_delay, "max_delay": settings.max_endpointing_delay},
            "interruption": {"enabled": True, "min_duration": settings.min_interruption_duration, "min_words": settings.min_interruption_words},
            "preemptive_generation": {"enabled": settings.preemptive_generation},
        },
        max_tool_steps=settings.max_tool_steps,
    )

    @session.on("metrics_collected")
    def _on_metrics(ev) -> None:
        log.on_metrics(ev.metrics)

    @session.on("conversation_item_added")
    def _on_item(ev) -> None:
        item = ev.item
        role = getattr(item, "role", None)
        text = getattr(item, "text_content", None) if hasattr(item, "text_content") else None
        if role == "user":
            gate.next_turn()
        if role in ("user", "assistant") and text:
            log.on_transcript(role, text, interrupted=bool(getattr(item, "interrupted", False)))

    async def _save_transcript(*_: Any) -> None:
        try:
            history = session.history.to_dict(exclude_function_call=False).get("items")
        except Exception:  # noqa: BLE001
            history = None
        log.close(history)

    ctx.add_shutdown_callback(_save_transcript)

    nc = None
    if noise_cancellation is not None and settings_nc_mode() != "off":
        nc = noise_cancellation.BVCTelephony() if is_sip else noise_cancellation.BVC()
    room_options = room_io.RoomOptions(audio_input=room_io.AudioInputOptions(noise_cancellation=nc))

    if is_sip and not phone_allowed(phone, allowed):
        logger.warning("caller not allowed", extra={"phone": phone})
        await session.start(Agent(instructions="אתה עונה למתקשר לא מורשה. אמור רק את המשפט שנאמר לך."), room=ctx.room, room_options=room_options)
        await session.say("מצטער, המספר הזה לא מורשה להשתמש בעוזר. להתראות.", allow_interruptions=False).wait_for_playout()
        await asyncio.sleep(0.5)
        await ctx.delete_room()
        return

    agent = MainbotAgent(instructions=instructions, mcp_servers=mcp_servers, gate=gate, bridge=bridge, phone=phone, greeting=settings.greeting)
    await session.start(agent, room=ctx.room, room_options=room_options)


def settings_nc_mode() -> str:
    import os

    return (os.getenv("RT_NOISE_CANCELLATION") or "auto").lower()


if __name__ == "__main__":
    cli.run_app(server)
