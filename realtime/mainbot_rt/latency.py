"""Per-stage latency log (EOU / STT / LLM / TTS) and the conversation transcript.

One JSONL file per session under RT_DATA_DIR/realtime/<date>/<room>.jsonl - the
numbers you need to see where the 700 ms - 1.5 s budget goes.
"""

from __future__ import annotations

import json
import logging
import os
import time
from datetime import datetime
from typing import Any

from livekit.agents import metrics

logger = logging.getLogger("mainbot.rt.latency")


class SessionLog:
    def __init__(self, data_dir: str, room: str, phone: str) -> None:
        day = datetime.now().strftime("%Y-%m-%d")
        self.dir = os.path.join(data_dir, "realtime", day)
        os.makedirs(self.dir, exist_ok=True)
        safe_room = "".join(c if c.isalnum() or c in "-_" else "_" for c in room)[:80]
        self.path = os.path.join(self.dir, f"{safe_room}.jsonl")
        self.room = room
        self.phone = phone
        self.started = time.time()
        self.usage = metrics.UsageCollector()
        self._turn: dict[str, Any] = {}
        self._write({"kind": "session_start", "room": room, "phone": phone})

    def _write(self, record: dict[str, Any]) -> None:
        record.setdefault("ts", datetime.now().isoformat(timespec="milliseconds"))
        with open(self.path, "a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False) + "\n")

    def on_metrics(self, m: metrics.AgentMetrics) -> None:
        self.usage.collect(m)
        record: dict[str, Any] = {"kind": "metrics", "metric": m.type}
        if isinstance(m, metrics.EOUMetrics):
            record.update(end_of_utterance_delay=m.end_of_utterance_delay, transcription_delay=m.transcription_delay, on_user_turn_completed_delay=m.on_user_turn_completed_delay)
            self._turn = {"eou": m.end_of_utterance_delay, "transcription": m.transcription_delay}
        elif isinstance(m, metrics.LLMMetrics):
            record.update(ttft=m.ttft, duration=m.duration, prompt_tokens=m.prompt_tokens, cached_tokens=m.prompt_cached_tokens, completion_tokens=m.completion_tokens, cancelled=m.cancelled)
            self._turn["llm_ttft"] = m.ttft
        elif isinstance(m, metrics.TTSMetrics):
            record.update(ttfb=m.ttfb, duration=m.duration, audio_duration=m.audio_duration, characters=m.characters_count, cancelled=m.cancelled)
            self._turn["tts_ttfb"] = m.ttfb
            # One user turn is complete once TTS started: log the end-to-end estimate.
            eou = self._turn.get("eou")
            if eou is not None and "llm_ttft" in self._turn:
                total = eou + self._turn["llm_ttft"] + m.ttfb
                self._write({"kind": "turn_latency", "eou_delay": eou, "transcription_delay": self._turn.get("transcription"), "llm_ttft": self._turn["llm_ttft"], "tts_ttfb": m.ttfb, "estimated_response_delay": round(total, 3)})
                logger.info("turn latency: eou=%.2fs llm_ttft=%.2fs tts_ttfb=%.2fs total~%.2fs", eou, self._turn["llm_ttft"], m.ttfb, total)
                self._turn = {}
        elif isinstance(m, metrics.STTMetrics):
            record.update(duration=m.duration, audio_duration=m.audio_duration)
        else:
            record["raw"] = m.model_dump(mode="json") if hasattr(m, "model_dump") else str(m)
        self._write(record)

    def on_transcript(self, role: str, text: str, *, interrupted: bool = False) -> None:
        self._write({"kind": "transcript", "role": role, "text": text, "interrupted": interrupted})

    def on_tool(self, name: str, decision: str, arguments: dict[str, Any]) -> None:
        self._write({"kind": "tool", "tool": name, "decision": decision, "arguments": arguments})

    def close(self, history: list[dict[str, Any]] | None = None) -> None:
        summary = self.usage.get_summary()
        self._write(
            {
                "kind": "session_end",
                "duration_s": round(time.time() - self.started, 1),
                "usage": summary.__dict__ if hasattr(summary, "__dict__") else str(summary),
                "history": history,
            }
        )
