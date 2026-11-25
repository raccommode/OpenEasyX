import json
import os
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory

from inference_memory import release_models
from runtime import parent_watch, progress, provision, publish


def setup_runtime(data):
    try:
        provision(data)
    except (OSError, RuntimeError, subprocess.SubprocessError) as error:
        publish(errorCode="DUBBING_RUNTIME_SETUP", message=str(error))
        raise


def reuse_separated_source(old_dir, work):
    # Only these two files predate speaker assignment. They were published by
    # atomic rename inside the same source fingerprint's work directory.
    names = ("mix.wav", "dialogue-bandit-v2.wav")
    if not old_dir or not all((Path(old_dir)/name).is_file() for name in names):
        return
    for name in names:
        try:
            os.link(Path(old_dir)/name, work/name)
        except OSError:
            # Existing files can be reused, and a filesystem without hard
            # links can rebuild its missing files through the normal worker.
            pass


def run(job, details=None):
    data, work, source = (Path(job[key]).resolve() for key in ("dataDir", "workDir", "source"))
    target = job["language"]
    work.mkdir(parents=True, exist_ok=True)
    os.environ.setdefault("HF_HOME", str(data / "dubbing-models" / "huggingface"))
    os.environ.setdefault("TORCH_HOME", str(data / "dubbing-models" / "torch"))
    os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")
    os.environ.setdefault("GRADIO_ANALYTICS_ENABLED", "False")
    previous = job.get("previousOutput")
    generation = job.get("audioGeneration")
    lip_sync = job.get("lipSync") is True
    output = Path(job["output"])
    from delivery import mux_original_picture, verify_playback
    from sync_cache import keep, move, restore
    if not lip_sync and previous and previous["renderVersion"] == f"{generation}-lips":
        progress("Restoring the original picture with the published dubbed audio", 75)
        mux_original_picture(source, previous["path"], output, language=target, published_audio=True,
                             prepare_recovery=lambda: setup_runtime(data))
        move(job, previous["path"], output)
        if details is not None:
            details["lipSyncFrames"] = 0
        return "rendered"
    audio = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "a:0", "-show_entries", "stream=index",
                            "-of", "csv=p=0", str(source)], capture_output=True, text=True, check=True)
    if not audio.stdout.strip():
        return "silent"
    setup_runtime(data)
    import torch
    torch.set_num_threads(min(4, os.cpu_count() or 1))
    if lip_sync and previous and previous["renderVersion"] == f"{generation}-audio":
        with TemporaryDirectory(dir=work) as temp:
            cues = restore(job, previous["path"], Path(temp))
            if cues:
                from lips import render
                progress("Synchronizing lips to the published dubbed voices", 70)
                changed = render(source, Path(previous["path"]), cues, Path(temp), output,
                                 language=target, published_audio=True)
                verify_playback(output)
                move(job, previous["path"], output)
                if details is not None:
                    details["lipSyncFrames"] = changed
                return "rendered"
    from dialogue import separate_dialogue, transcribe
    from voices import mix_voices, speak
    from speech_translation import translate_speech
    from speech_review import review_transcript

    progress("Separating dialogue from original soundtrack", 2)
    reuse_separated_source(job.get("previousStemDir"), work)
    mix, dialogue = separate_dialogue(source, work, model_cache=data / "subtitle-models")
    release_models()
    progress("Identifying speakers", 15)
    cues = transcribe(dialogue, work, data / "subtitle-models")
    cues, checkpoints = review_transcript(cues, work, data / "subtitle-models", dialogue=dialogue)
    release_models()
    if not cues:
        return "silent"
    if all(c["language"] == target for c in cues):
        return "original"
    from speaker_library import prepare_references
    references, reference_key = prepare_references(job, data, work, cues, analysis=checkpoints.name)
    release_models()
    progress("Translating dialogue", 30)
    texts = translate_speech(cues, target, work, checkpoints/f"translation-{target}.json")
    release_models()
    wav_dir = checkpoints / (f"voice-{target}-{reference_key}" if reference_key else f"voice-{target}")
    wav_dir.mkdir(exist_ok=True)
    speak(cues, texts, target, work, wav_dir, references, data / "subtitle-models")
    release_models()
    mixed = wav_dir / "soundtrack.wav"
    progress("Mixing voices with original music and effects", 69)
    mix_voices(mix, dialogue, cues, wav_dir, work, mixed, language=target)
    changed = 0
    if lip_sync:
        from lips import render
        changed = render(source, mixed, cues, wav_dir, output, language=target, source_audio=mix)
        verify_playback(output)
        progress(f"Animated visible speech in {changed} frames", 99)
    else:
        progress("Combining the original picture with dubbed audio", 90)
        mux_original_picture(source, mixed, output, language=target)
    keep(job, output, cues, wav_dir)
    if details is not None:
        details["lipSyncFrames"] = changed
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
