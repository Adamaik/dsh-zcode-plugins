#!/usr/bin/env python3
"""Transcribe one 16 kHz mono WAV with faster-whisper.

Invoked by the dsh-bilibili-summary plugin's audio fallback; not a general CLI.
Writes a JSON record with the detected language and `{from, to, text}` segments,
so the Node side can reuse the same transcript shaping as subtitle tracks.
"""

import argparse
import json
import sys


def main() -> int:
    parser = argparse.ArgumentParser(description="Transcribe a WAV file with faster-whisper")
    parser.add_argument("--audio", required=True, help="16 kHz mono PCM WAV path")
    parser.add_argument("--out", required=True, help="JSON output path")
    parser.add_argument("--model", default="small", help="faster-whisper model name or local path")
    parser.add_argument("--language", default="", help="ISO language code; empty means auto-detect")
    parser.add_argument("--model-dir", default="", help="model download cache")
    parser.add_argument("--vad", default="true", help="apply the VAD filter")
    args = parser.parse_args()

    try:
        from faster_whisper import WhisperModel
    except ImportError:
        print(
            "faster-whisper is not importable by this interpreter; create a virtualenv first",
            file=sys.stderr,
        )
        return 2

    model = WhisperModel(
        args.model,
        device="cpu",
        compute_type="int8",
        download_root=args.model_dir or None,
    )
    segments, info = model.transcribe(
        args.audio,
        beam_size=5,
        vad_filter=args.vad.lower() != "false",
        language=args.language or None,
    )
    rows = [
        {"from": round(segment.start, 2), "to": round(segment.end, 2), "text": segment.text.strip()}
        for segment in segments
    ]
    with open(args.out, "w", encoding="utf-8") as handle:
        json.dump(
            {
                "language": info.language,
                "probability": round(float(info.language_probability), 4),
                "segments": rows,
            },
            handle,
            ensure_ascii=False,
        )
    print(json.dumps({"ok": True, "segments": len(rows), "language": info.language}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
