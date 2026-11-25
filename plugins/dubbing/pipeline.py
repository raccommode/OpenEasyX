import gc
import json
import os
from pathlib import Path
import subprocess
import sys

from runtime import parent_watch, progress, provision, publish


def release_models():
    import torch
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
    if torch.backends.mps.is_available():
        torch.mps.empty_cache()


def run(job, details=None):
    data, work, source = (Path(job[key]).resolve() for key in ("dataDir", "workDir", "source"))
    target = job["language"]
    work.mkdir(parents=True, exist_ok=True)
    previous = job.get("previousOutput")
    if previous and previous["renderVersion"] == "3":
        from delivery import optimize_published
        progress("Optimizing the published dub for playback", 10)
        optimize_published(Path(previous["path"]), Path(job["output"]))
        if details is not None and previous.get("lipSyncFrames") is not None:
            details["lipSyncFrames"] = previous["lipSyncFrames"]
        return "rendered"
    audio = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "a:0", "-show_entries", "stream=index",
                            "-of", "csv=p=0", str(source)], capture_output=True, text=True, check=True)
    if not audio.stdout.strip():
        return "silent"
    os.environ.setdefault("HF_HOME", str(data / "dubbing-models" / "huggingface"))
    os.environ.setdefault("TORCH_HOME", str(data / "dubbing-models" / "torch"))
    os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")
    os.environ.setdefault("GRADIO_ANALYTICS_ENABLED", "False")
    try:
        provision(data)
    except (OSError, RuntimeError, subprocess.SubprocessError) as error:
        publish(errorCode="DUBBING_RUNTIME_SETUP", message=str(error))
        raise
    import torch
    torch.set_num_threads(min(4, os.cpu_count() or 1))
    from dialogue import separate_dialogue, transcribe
    from voices import mix_voices, speak, translate
    from speech_review import review_transcript

    progress("Separating dialogue from original soundtrack", 2)
    mix, dialogue = separate_dialogue(source, work)
    release_models()
    progress("Identifying speakers", 15)
    cues = transcribe(dialogue, work, data / "subtitle-models")
    cues, checkpoints = review_transcript(cues, work, data / "subtitle-models")
    release_models()
    if not cues:
        return "silent"
    if all(c["language"] == target for c in cues):
        return "original"
    from speaker_library import prepare_references
    references, reference_key = prepare_references(job, data, work, cues)
    release_models()
    progress("Translating dialogue", 30)
    texts = translate(cues, target, checkpoints/f"translation-{target}.json")
    release_models()
    wav_dir = checkpoints / (f"voice-{target}-{reference_key}" if reference_key else f"voice-{target}")
    wav_dir.mkdir(exist_ok=True)
    speak(cues, texts, target, work, wav_dir, references, data / "subtitle-models")
    release_models()
    mixed = wav_dir / "soundtrack.wav"
    progress("Mixing voices with original music and effects", 69)
    mix_voices(mix, dialogue, cues, wav_dir, work, mixed)
    from lips import render
    changed = render(source, mixed, cues, wav_dir, Path(job["output"]), language=target, source_audio=mix)
    from delivery import verify_playback
    verify_playback(job["output"])
    if details is not None:
        details["lipSyncFrames"] = changed
    progress(f"Animated visible speech in {changed} frames", 99)
    # Keep shared analysis for other selected languages. Per-language PCM is only needed to resume an unfinished render.
    import shutil
    shutil.rmtree(wav_dir)
    return "rendered"


if __name__ == "__main__":
    parent_watch()
    arg = sys.argv[1]
    job = json.loads(arg if arg.startswith("{") else Path(arg).read_text())
    details = {}
    try:
        outcome = run(job, details)
    except Exception as error:
        publish(errorCode="DUBBING_RENDER_FAILED", message=str(error) or type(error).__name__)
        raise
    publish(outcome=outcome, **details)
