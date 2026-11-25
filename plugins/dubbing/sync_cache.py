"""Small per-language speech cache for switching the picture without changing the dub."""
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import zipfile

MAX_BYTES = 16 * 1024 * 1024


def archive(job, publication):
    # Both paths come from the host. Renaming a completed MP4 preserves these stats.
    stat = Path(publication).stat()
    return Path(job["speechCacheDir"]) / job["language"] / f"{stat.st_size}-{stat.st_mtime_ns}.zip"


def keep(job, publication, cues, wav_dir):
    import soundfile as sf
    from speech_review import at16
    if not job.get("speechCacheDir"):
        return
    tmp_path = None
    try:
        dest = archive(job, publication)
        dest.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(dir=dest.parent, suffix=".tmp", delete=False) as tmp:
            tmp_path = Path(tmp.name)
        with zipfile.ZipFile(tmp_path, "w") as pack:
            timeline = []
            for i, cue in enumerate(cues):
                item = {k: cue[k] for k in ("start", "end", "speaker")}
                path = wav_dir / f"{i}.wav"
                item["translated"] = path.is_file()
                timeline.append(item)
                if item["translated"]:
                    wave, rate = sf.read(path, dtype="float32")
                    buf = io.BytesIO()
                    sf.write(buf, at16(wave, rate), 16000, format="FLAC", subtype="PCM_16")
                    pack.writestr(f"{i}.flac", buf.getvalue())
                if tmp_path.stat().st_size > MAX_BYTES:
                    return
            pack.writestr("timeline.json", json.dumps(timeline))
        if tmp_path.stat().st_size > MAX_BYTES:
            return
        os.replace(tmp_path, dest)
        for old in dest.parent.glob("*.zip"):
            if old != dest:
                old.unlink(missing_ok=True)
    except (OSError, sf.LibsndfileError) as error:
        print(f"Could not cache lip-sync timing: {error}", file=sys.stderr)
    finally:
        if tmp_path is not None:
            tmp_path.unlink(missing_ok=True)


def restore(job, previous, destination):
    import soundfile as sf
    if not job.get("speechCacheDir"):
        return
    try:
        with zipfile.ZipFile(archive(job, previous)) as pack:
            cues = json.loads(pack.read("timeline.json"))
            for i, cue in enumerate(cues):
                if cue["translated"]:
                    waveform, rate = sf.read(io.BytesIO(pack.read(f"{i}.flac")), dtype="float32")
                    sf.write(destination / f"{i}.wav", waveform, rate, subtype="FLOAT")
            return cues
    except (OSError, ValueError, KeyError, RuntimeError, zipfile.BadZipFile):
        return None


def move(job, previous, publication):
    if job.get("speechCacheDir"):
        try:
            source = archive(job, previous)
            if source.is_file():
                source.replace(archive(job, publication))
        except OSError as error:
            print(f"Could not update lip-sync timing cache: {error}", file=sys.stderr)
