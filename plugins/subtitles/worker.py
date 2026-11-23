from __future__ import annotations

import hashlib
import html
import json
import math
import os
import platform
import shutil
import signal
import sqlite3
import subprocess
import sys
import threading
import time
from collections.abc import Iterator
from contextlib import closing, contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

DATA_ROOT = Path(os.environ.get("EASYX_DATA_DIR", "/data")).resolve()
MEDIA_ROOT = Path(os.environ.get("EASYX_MEDIA_DIR", "/media"))
DB_PATH = Path(os.environ.get("EASYX_SUBTITLE_DATABASE", DATA_ROOT / "open-easyx-library.sqlite"))
RUNTIME_ROOT = DATA_ROOT / "subtitle-runtime" / f"{sys.platform}-{platform.machine()}-py{sys.version_info.major}.{sys.version_info.minor}"
SUBTITLE_ROOT = DATA_ROOT / "subtitles"
MODEL_ROOT = DATA_ROOT / "subtitle-models"
WHISPER_MODEL = os.environ.get("EASYX_WHISPER_MODEL", "small")
TRANSLATION_MODEL = os.environ.get("EASYX_TRANSLATION_MODEL", "facebook/nllb-200-distilled-600M")
CHUNK_SECONDS = max(120, min(1800, int(os.environ.get("EASYX_SUBTITLE_CHUNK_SECONDS", "600"))))

LANGUAGES = {
    item["code"]: (item["label"], item["nllb"])
    for item in json.loads(Path(__file__).with_name("languages.json").read_text(encoding="utf-8"))
}


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


@contextmanager
def connect() -> Iterator[sqlite3.Connection]:
    with closing(sqlite3.connect(DB_PATH, timeout=30)) as con:
        con.row_factory = sqlite3.Row
        con.execute("PRAGMA foreign_keys=ON")
        with con:
            yield con


def set_state(key: str, value: Any) -> None:
    with connect() as con:
        con.execute(
            """INSERT INTO settings(key,value_json,updated_at) VALUES(?,?,?)
            ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at""",
            (key, json.dumps(value, ensure_ascii=False), now()),
        )


def enter_runtime() -> None:
    """Use a persistent, isolated interpreter once there is actual work to do."""
    if os.environ.get("EASYX_SUBTITLE_PYTHON") or Path(sys.prefix).resolve() == RUNTIME_ROOT:
        return
    executable = RUNTIME_ROOT / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    if not executable.is_file() or not (RUNTIME_ROOT / "pyvenv.cfg").is_file():
        subprocess.run([sys.executable, "-m", "venv", "--without-pip", str(RUNTIME_ROOT)], check=True)
    os.execv(str(executable), [str(executable), __file__])


def ensure_dependency(feature: str) -> None:
    # An explicitly configured interpreter is provisioned by its owner.
    if os.environ.get("EASYX_SUBTITLE_PYTHON"):
        return
    if Path(sys.prefix).resolve() != RUNTIME_ROOT:
        raise RuntimeError("subtitle dependencies require the plugin's isolated runtime")
    requirements = Path(__file__).with_name(f"requirements-{feature}.txt")
    torch_requirement = "torch==2.9.1" if feature == "translation" else ""
    version = hashlib.sha256(requirements.read_bytes() + torch_requirement.encode()).hexdigest()
    marker = RUNTIME_ROOT / f".{feature}.ready"
    if marker.is_file() and marker.read_text(encoding="utf-8") == version:
        return
    print(f"Preparing local {feature} dependencies", flush=True)
    def install(*args: str) -> None:
        result = subprocess.run([sys.executable, "-m", *args], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        if result.returncode:
            raise RuntimeError(f"Installing {feature} dependencies failed: {result.stdout[-1200:]}")
    install("ensurepip")
    pip = ["pip", "--disable-pip-version-check", "install", "--no-cache-dir", "--progress-bar", "off"]
    if torch_requirement:
        index = ["--index-url", "https://download.pytorch.org/whl/cpu"] if sys.platform == "linux" else []
        install(*pip, *index, torch_requirement)
    install(*pip, "-r", str(requirements))
    temporary = marker.with_suffix(".tmp")
    temporary.write_text(version, encoding="utf-8")
    temporary.replace(marker)


def stop_on_parent_exit() -> None:
    # An abruptly terminated server closes stdin just as surely as a normal shutdown.
    sys.stdin.buffer.read()
    if hasattr(os, "killpg") and os.getpgrp() == os.getpid():
        os.killpg(os.getpid(), signal.SIGTERM)
    else:
        os._exit(0)


def fingerprint(row: sqlite3.Row) -> str:
    return f"{int(row['size'])}:{row['modified_at']}"


def discover(targets: list[str]) -> None:
    requested = json.dumps(targets, separators=(",", ":"))
    stamp = now()
    with connect() as con:
        videos = con.execute(
            """SELECT m.id, m.size, m.modified_at, j.fingerprint AS previous_fingerprint
            FROM media m LEFT JOIN subtitle_jobs j ON j.media_id=m.id
            WHERE m.kind='video' AND m.missing=0 AND (
                j.media_id IS NULL OR j.fingerprint != (m.size || ':' || m.modified_at)
                OR j.requested_languages_json != ?)""", (requested,)
        ).fetchall()
        for video in videos:
            current = fingerprint(video)
            if video["previous_fingerprint"] is None:
                con.execute(
                    "INSERT INTO subtitle_jobs(media_id,fingerprint,requested_languages_json,status,updated_at) VALUES(?,?,?,'queued',?)",
                    (video["id"], current, requested, stamp),
                )
            elif video["previous_fingerprint"] != current:
                con.execute(
                    """UPDATE subtitle_jobs SET fingerprint=?,requested_languages_json=?,status='queued',source_language='',
                    source_language_probability=0,progress=0,attempts=0,last_error='',completed_at=NULL,updated_at=? WHERE media_id=?""",
                    (current, requested, stamp, video["id"]),
                )
                con.execute("DELETE FROM subtitle_tracks WHERE media_id=? AND origin!='manual'", (video["id"],))
            else:
                con.execute(
                    "UPDATE subtitle_jobs SET requested_languages_json=?,status='queued',progress=0,attempts=0,last_error='',updated_at=? WHERE media_id=?",
                    (requested, stamp, video["id"]),
                )


def next_job() -> sqlite3.Row | None:
    with connect() as con:
        return con.execute(
            """SELECT m.*,j.fingerprint,j.requested_languages_json,j.source_language,j.attempts
            FROM subtitle_jobs j JOIN media m ON m.id=j.media_id
            WHERE m.kind='video' AND m.missing=0 AND (j.status='queued' OR (j.status='error' AND j.attempts<3))
            ORDER BY m.modified_at ASC LIMIT 1"""
        ).fetchone()


def media_path(relative_path: str) -> Path:
    root = MEDIA_ROOT.resolve()
    candidate = (root / relative_path).resolve()
    if root not in candidate.parents:
        raise RuntimeError("media path escapes the configured root")
    return candidate


def probe_duration(source: Path) -> float:
    result = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", str(source)],
        capture_output=True, text=True, timeout=120, check=False,
    )
    try:
        return max(0.0, float(result.stdout.strip()))
    except ValueError:
        return 0.0


def has_audio(source: Path) -> bool:
    result = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "a:0", "-show_entries", "stream=index", "-of", "csv=p=0", str(source)],
        capture_output=True, text=True, timeout=120, check=False,
    )
    if result.returncode:
        raise RuntimeError((result.stderr or "could not inspect the audio stream")[-1000:])
    return bool(result.stdout.strip())


def extract_audio(source: Path, target: Path, start: float, duration: float) -> None:
    result = subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-ss", f"{start:.3f}", "-i", str(source),
         "-t", f"{duration:.3f}", "-vn", "-ac", "1", "-ar", "16000", "-c:a", "flac", "-y", str(target)],
        capture_output=True, text=True, timeout=max(300, int(duration * 2)), check=False,
    )
    if result.returncode or not target.is_file() or not target.stat().st_size:
        raise RuntimeError((result.stderr or "audio extraction failed")[-1000:])


def vtt_time(value: float) -> str:
    milliseconds = max(0, round(value * 1000))
    hours, milliseconds = divmod(milliseconds, 3_600_000)
    minutes, milliseconds = divmod(milliseconds, 60_000)
    seconds, milliseconds = divmod(milliseconds, 1000)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d}.{milliseconds:03d}"


def render_vtt(cues: list[dict[str, Any]]) -> str:
    lines = ["WEBVTT", ""]
    for index, cue in enumerate(cues, 1):
        text = " ".join(str(cue.get("text", "")).split())
        if not text:
            continue
        start = max(0.0, float(cue["start"]))
        end = float(cue["end"])
        if index < len(cues):
            end = min(end, float(cues[index]["start"]))
        end = max(start + 0.001, end)
        lines.extend([str(index), f"{vtt_time(start)} --> {vtt_time(end)}", html.escape(text, quote=False), ""])
    return "\n".join(lines)


def write_track(media_id: str, track_id: str, language: str, label: str, origin: str, source_language: str, cues: list[dict[str, Any]]) -> None:
    directory = SUBTITLE_ROOT / media_id
    directory.mkdir(parents=True, exist_ok=True)
    destination = directory / f"{track_id}.vtt"
    temporary = destination.with_suffix(".vtt.tmp")
    temporary.write_text(render_vtt(cues), encoding="utf-8")
    temporary.replace(destination)
    with connect() as con:
        con.execute(
            """INSERT INTO subtitle_tracks(id,media_id,language,label,origin,source_language,updated_at)
            VALUES(?,?,?,?,?,?,?) ON CONFLICT(media_id,id) DO UPDATE SET language=excluded.language,label=excluded.label,
            origin=excluded.origin,source_language=excluded.source_language,updated_at=excluded.updated_at""",
            (track_id, media_id, language, label, origin, source_language, now()),
        )


def translate(cues: list[dict[str, Any]], source: str, targets: list[str], media_id: str) -> None:
    if not targets:
        return
    if source not in LANGUAGES:
        raise RuntimeError(f"translation from detected language '{source}' is not supported yet")
    ensure_dependency("translation")
    import torch
    from transformers import AutoModelForSeq2SeqLM, AutoTokenizer

    torch.set_num_threads(1)
    tokenizer = AutoTokenizer.from_pretrained(TRANSLATION_MODEL, cache_dir=MODEL_ROOT, src_lang=LANGUAGES[source][1])
    model = AutoModelForSeq2SeqLM.from_pretrained(TRANSLATION_MODEL, cache_dir=MODEL_ROOT)
    model.eval()
    with torch.inference_mode():
        for target_index, target in enumerate(targets):
            translated: list[dict[str, Any]] = []
            for offset in range(0, len(cues), 8):
                batch = cues[offset:offset + 8]
                encoded = tokenizer([cue["text"] for cue in batch], return_tensors="pt", padding=True, truncation=True, max_length=512)
                output = model.generate(**encoded, forced_bos_token_id=tokenizer.convert_tokens_to_ids(LANGUAGES[target][1]), max_new_tokens=256)
                texts = tokenizer.batch_decode(output, skip_special_tokens=True)
                translated.extend({**cue, "text": " ".join(text.split())} for cue, text in zip(batch, texts))
            write_track(media_id, target, target, LANGUAGES[target][0], "generated", source, translated)
            with connect() as con:
                con.execute("UPDATE subtitle_jobs SET progress=?,updated_at=? WHERE media_id=?", (80 + 19 * (target_index + 1) / len(targets), now(), media_id))


def save_transcript(file: Path, payload: dict[str, Any]) -> None:
    temporary = file.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    temporary.replace(file)


def load_transcript(file: Path, expected: dict[str, Any]) -> dict[str, Any] | None:
    try:
        payload = json.loads(file.read_text(encoding="utf-8"))
    except (FileNotFoundError, ValueError):
        return None
    if not isinstance(payload, dict) or any(payload.get(key) != value for key, value in expected.items()):
        return None
    if not isinstance(payload.get("language"), str) or not isinstance(payload.get("probability"), (int, float)):
        return None
    cues = payload.get("cues")
    if not isinstance(cues, list) or any(
        not isinstance(cue, dict) or not isinstance(cue.get("text"), str)
        or not all(isinstance(cue.get(key), (int, float)) and math.isfinite(cue[key]) for key in ("start", "end"))
        for cue in cues
    ):
        return None
    return payload


def transcribe(row: sqlite3.Row, source: Path, duration: float) -> tuple[str, float, list[dict[str, Any]]]:
    media_id = str(row["id"])
    work = SUBTITLE_ROOT / media_id / "work"
    work.mkdir(parents=True, exist_ok=True)
    cache_key = {"fingerprint": fingerprint(row), "model": WHISPER_MODEL, "chunkSeconds": CHUNK_SECONDS}
    model = None
    language = ""
    probability = 0.0
    cues: list[dict[str, Any]] = []
    chunks = max(1, math.ceil(duration / CHUNK_SECONDS))
    for index in range(chunks):
        start = index * CHUNK_SECONDS
        length = min(CHUNK_SECONDS, duration - start)
        checkpoint = work / f"chunk-{index:06d}.json"
        payload = load_transcript(checkpoint, cache_key)
        if payload is not None:
            language = language or payload.get("language", "")
            probability = max(probability, float(payload.get("probability", 0)))
            cues.extend(payload.get("cues", []))
            continue
        if model is None:
            ensure_dependency("transcription")
            from faster_whisper import WhisperModel
            model = WhisperModel(WHISPER_MODEL, device="cpu", compute_type="int8", cpu_threads=1, num_workers=1, download_root=str(MODEL_ROOT))
        audio = work / f"chunk-{index:06d}.flac"
        extract_audio(source, audio, start, length)
        try:
            segments, info = model.transcribe(str(audio), task="transcribe", language=language or None, vad_filter=True, beam_size=1, condition_on_previous_text=False)
            chunk_cues = [
                {"start": round(start + float(segment.start), 3), "end": round(start + float(segment.end), 3), "text": " ".join(str(segment.text or "").split())}
                for segment in segments if str(segment.text or "").strip()
            ]
            if chunk_cues:
                language = language or str(info.language or "en")
                probability = max(probability, float(info.language_probability or 0))
            cues.extend(chunk_cues)
            save_transcript(checkpoint, {**cache_key, "language": language, "probability": probability, "cues": chunk_cues})
        finally:
            audio.unlink(missing_ok=True)
        with connect() as con:
            con.execute("UPDATE subtitle_jobs SET source_language=?,source_language_probability=?,progress=?,updated_at=? WHERE media_id=?", (language, probability, min(80, 80 * (index + 1) / chunks), now(), media_id))
    return language or "en", probability, cues


def process(row: sqlite3.Row, targets: list[str]) -> None:
    media_id = str(row["id"])
    source = media_path(str(row["relative_path"]))
    if not source.is_file():
        raise RuntimeError("media file is not available")
    if not has_audio(source):
        with connect() as con:
            con.execute("UPDATE subtitle_jobs SET status='no_audio',progress=100,completed_at=?,updated_at=? WHERE media_id=?", (now(), now(), media_id))
        return
    duration = float(row["duration"] or 0) or probe_duration(source)
    if duration <= 0:
        raise RuntimeError("video duration is unknown")
    with connect() as con:
        con.execute("UPDATE media SET duration=CASE WHEN duration>0 THEN duration ELSE ? END WHERE id=?", (duration, media_id))
    original_json = SUBTITLE_ROOT / media_id / "original.json"
    cache_key = {"fingerprint": fingerprint(row)}
    payload = load_transcript(original_json, cache_key)
    if payload is None:
        language, probability, cues = transcribe(row, source, duration)
        save_transcript(original_json, {**cache_key, "language": language, "probability": probability, "cues": cues})
    else:
        language, probability, cues = payload["language"], payload["probability"], payload["cues"]
    work = original_json.parent / "work"
    if work.is_dir():
        shutil.rmtree(work)
    if not cues:
        with connect() as con:
            con.execute("UPDATE subtitle_jobs SET status='no_speech',progress=100,completed_at=?,updated_at=? WHERE media_id=?", (now(), now(), media_id))
        return
    original_label = f"Original · {LANGUAGES.get(language, (language.upper(), ''))[0]}"
    write_track(media_id, "original", language, original_label, "original", language, cues)
    required = [target for target in targets if target != language]
    with connect() as con:
        completed = con.execute("SELECT id FROM subtitle_tracks WHERE media_id=? AND origin='generated' AND source_language=?", (media_id, language)).fetchall()
    cached = {track["id"] for track in completed if (original_json.parent / f"{track['id']}.vtt").is_file()}
    translate(cues, language, [target for target in required if target not in cached], media_id)
    with connect() as con:
        if required:
            placeholders = ",".join("?" for _ in required)
            con.execute(f"DELETE FROM subtitle_tracks WHERE media_id=? AND origin='generated' AND language NOT IN ({placeholders})", (media_id, *required))
        else:
            con.execute("DELETE FROM subtitle_tracks WHERE media_id=? AND origin='generated'", (media_id,))
        con.execute("UPDATE subtitle_jobs SET status='complete',source_language=?,source_language_probability=?,progress=100,last_error='',completed_at=?,updated_at=? WHERE media_id=?", (language, probability, now(), now(), media_id))


def main() -> None:
    if os.environ.get("EASYX_SUBTITLE_PARENT_PIPE") == "1":
        threading.Thread(target=stop_on_parent_exit, daemon=True).start()
    if not DB_PATH.is_file():
        raise RuntimeError(f"library database not found at {DB_PATH}")
    targets = sorted(set(json.loads(os.environ.get("EASYX_SUBTITLE_LANGUAGES", "[]"))) & LANGUAGES.keys())
    with connect() as con:
        con.execute("UPDATE subtitle_jobs SET status='queued', attempts=MAX(0,attempts-1), updated_at=? WHERE status='running'", (now(),))
    while True:
        discover(targets)
        job = next_job()
        if not job:
            set_state("subtitle_worker_runtime", {"state": "idle", "heartbeat": now()})
            time.sleep(5)
            continue
        set_state("subtitle_worker_runtime", {"state": "processing", "mediaId": job["id"], "title": job["title"], "heartbeat": now()})
        heartbeat_stop = threading.Event()

        def heartbeat() -> None:
            while not heartbeat_stop.wait(10):
                set_state("subtitle_worker_runtime", {"state": "processing", "mediaId": job["id"], "title": job["title"], "heartbeat": now()})

        heartbeat_thread = threading.Thread(target=heartbeat, name="subtitle-heartbeat", daemon=True)
        heartbeat_thread.start()
        failure: Exception | None = None
        try:
            with connect() as con:
                con.execute("UPDATE subtitle_jobs SET status='running',attempts=attempts+1,progress=0,last_error='',started_at=?,updated_at=? WHERE media_id=?", (now(), now(), job["id"]))
            enter_runtime()
            process(job, targets)
        except Exception as error:
            failure = error
        finally:
            heartbeat_stop.set()
            heartbeat_thread.join(timeout=2)
        if failure is not None:
            with connect() as con:
                con.execute("UPDATE subtitle_jobs SET status='error',last_error=?,updated_at=? WHERE media_id=?", (str(failure)[-1500:], now(), job["id"]))
            set_state("subtitle_worker_runtime", {"state": "error", "mediaId": job["id"], "title": job["title"], "error": str(failure)[-500:], "heartbeat": now()})
            time.sleep(10)


if __name__ == "__main__":
    main()
