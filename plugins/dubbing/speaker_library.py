"""Acoustically verified multi-video voice prompts, kept in the local data directory."""
import hashlib
import itertools
import json
from pathlib import Path
import shutil
import sqlite3
import subprocess
import tempfile
import time

import numpy as np
import soundfile as sf

from runtime import progress
from voice_samples import RATE, VoiceSampler, decode, original_audio


MAX_CATALOG_VIDEOS = 32
MAX_BANK_BYTES = 64*1024*1024
VERSION = 3  # Speaker numbers and clean reference clips are derived from this generation's separator.


def signature(item):
    source = Path(item["source"])
    stat = source.stat()
    return (str(item["mediaId"]), str(item["fingerprint"]), str(source.resolve()), stat.st_dev,
            stat.st_ino, stat.st_size, stat.st_mtime_ns)


def token(value):
    return hashlib.sha256(json.dumps(value, separators=(",", ":")).encode()).hexdigest()


def similarity(left, right):
    # Full phrases and disjoint temporal halves provide separate identity evidence.
    scores = np.asarray(left["vectors"]) @ np.asarray(right["vectors"]).T
    halves = scores[1:, 1:]
    corroboration = min(halves.max(axis=0).min(), halves.max(axis=1).min())
    return float(.65*scores[0, 0]+.35*corroboration), float(corroboration)


def match_recording(anchors, candidates):
    evidence = {(a, b): similarity(x, y) for a, x in anchors.items() for b, y in candidates.items()}
    matched = {}
    for (a, b), (score, halves) in evidence.items():
        alternatives = [v[0] for (i, j), v in evidence.items() if (i == a) != (j == b)]
        if score >= .64 and halves >= .48 and score-max(alternatives, default=0.) >= .10:
            matched[a] = (candidates[b], score)
    return matched


def select_prompt(anchor, candidates):
    """Select entire utterances, one per recording, while keeping the local identity anchor."""
    ranked = sorted(candidates, key=lambda c: c[1]["quality"]*.65+c[2]*.35, reverse=True)
    selected = []
    duration = anchor["duration"]
    used_text = {anchor["text"].strip().casefold()}
    for media, row, _ in ranked:
        transcript = row["text"].strip().casefold()
        if (row["quality"] < max(.58, anchor["quality"]-.20) or transcript in used_text or duration+.12+row["duration"] > 12
                or any(similarity(row, other)[0] < .58 for _, other in selected)):
            continue
        selected.append((media, row))
        used_text.add(transcript)
        duration += .12+row["duration"]
        if len(selected) == 2:
            break
    return selected


def save_record(db, key, stamp, voices, complete):
    payload = json.dumps(voices, separators=(",", ":")).encode()
    with db:
        db.execute("INSERT OR REPLACE INTO recordings VALUES (?,?,?,?,?)",
                   (key, stamp, int(complete), time.time(), payload))
        used = 0
        for index, (media, size) in enumerate(db.execute(
                "SELECT media_id,LENGTH(voices) FROM recordings ORDER BY used DESC").fetchall()):
            used += size
            if used > MAX_BANK_BYTES or index >= 256:
                db.execute("DELETE FROM recordings WHERE media_id=?", (media,))


def cached(db, key, stamp, require_complete=False, prior_sample_stamp=None):
    row = db.execute("SELECT stamp,complete,voices,used FROM recordings WHERE media_id=?", (key,)).fetchone()
    if row is None:
        return None
    # The v2/v3 cinematic separator changed complete anchors, but related
    # recordings sampled directly from their original audio are equivalent.
    if row[0] != stamp and not (row[1] == 0 and row[0] == prior_sample_stamp):
        with db:
            db.execute("DELETE FROM recordings WHERE media_id=?", (key,))
        return None
    if row[1] < 0:
        # A broken or temporarily offline original must not starve later candidates.
        return {} if time.time()-row[3] < 3600 else None
    if require_complete and not row[1]:
        return None
    with db:
        db.execute("UPDATE recordings SET used=? WHERE media_id=?", (time.time(), key))
    return json.loads(row[2])


def selection_report(plan, work):
    counts = list(plan["sourceCounts"].values())
    actual = len(set(itertools.chain.from_iterable(plan["sources"].values())))
    if counts:
        progress(f"Cloning voices from {actual} original video{'s' if actual != 1 else ''} "
                 f"({', '.join(map(str, counts))} per speaker)", 30)
    return (work/("speaker-library-"+plan["key"]), plan["key"]) if plan["key"] else (work, "")


def prepare_references(job, data, work, cues):
    if not job.get("referenceVideos") or not job.get("mediaId") or not job.get("fingerprint"):
        return work, ""
    try:
        base = data/"dubbing-voices"
        base.mkdir(mode=0o700, parents=True, exist_ok=True)
        with sqlite3.connect(base/"references-v1.sqlite", timeout=10) as db:
            db.execute("CREATE TABLE IF NOT EXISTS recordings (media_id TEXT PRIMARY KEY, stamp TEXT, complete INTEGER, used REAL, voices BLOB)")
            return prepare(db, job, data, work, cues)
    except (OSError, TimeoutError, sqlite3.Error, ValueError, RuntimeError, subprocess.SubprocessError):
        progress("Using the original voices from this video", 30)
        return work, ""


def prepare(db, job, data, work, cues):
    current = signature(job)
    key = current[0]
    stamp = token((VERSION, current))
    identities = {(current[3], current[4])}
    keys = {key}
    candidates = []
    for row in job.get("referenceVideos", [])[:MAX_CATALOG_VIDEOS]:
        try:
            sig = signature(row)
        except (KeyError, OSError, TypeError):
            continue
        if sig[0] in keys or (sig[3], sig[4]) in identities:
            continue
        identities.add((sig[3], sig[4]))
        keys.add(sig[0])
        candidates.append((row, sig))
    search_key = token(("all-candidates", stamp, sorted(sig for _, sig in candidates)))
    snapshot = work/("voice-selection-"+search_key[:20]+".json")
    if snapshot.is_file():
        previous = json.loads(snapshot.read_text())
        if not previous["key"] or (work/("speaker-library-"+previous["key"])/"selection.json").is_file():
            return selection_report(previous, work)

    sampler = VoiceSampler(data/"subtitle-models")
    anchors = cached(db, key, stamp, require_complete=True)
    if anchors is None:
        # Current diarization uses the first audio track. Never learn from a dubbed first track.
        track = original_audio(job["source"])
        if not track or not track[2]:
            return work, ""
        anchors = sampler.from_work(work, cues)
        if signature(job) != current:
            return work, ""
        save_record(db, key, stamp, anchors, True)
    speakers = sorted({str(c["speaker"]) for c in cues})
    pool = {s: [] for s in anchors}
    for position, (row, sig) in enumerate(candidates if anchors else [], 1):
        media = sig[0]
        fingerprint = token((VERSION, sig))
        prior_sample_stamp = token((2, sig)) if VERSION == 3 else None
        bank = cached(db, media, fingerprint, prior_sample_stamp=prior_sample_stamp)
        if bank is None:
            progress(f"Checking original voices in related videos ({position}/{len(candidates)})",
                     27 + 3 * (position-1)/len(candidates))
            try:
                bank = sampler.from_video(sig[2])
                if signature(row) != sig:
                    continue
                save_record(db, media, fingerprint, bank, False)
            except (OSError, ValueError, RuntimeError, KeyError, subprocess.SubprocessError):
                save_record(db, media, fingerprint, {}, -1)
                continue
        # Do not assign a voice through a chain of performer tags or previous matches.
        for speaker, (sample, score) in match_recording(anchors, bank).items():
            pool[speaker].append((media, sample, score))
    folder = Path(tempfile.mkdtemp(prefix=".speaker-library-", dir=work))
    sources, digests = {s: [key] for s in speakers}, []
    try:
        for speaker, anchor in anchors.items():
            selected = select_prompt(anchor, pool[speaker])
            if not selected:
                continue
            entries = [(key, anchor), *selected]
            sources[speaker] = [media for media, _ in entries]
            clips = [decode(sample) for _, sample in entries]
            samples = [clips[0]]
            for clip in clips[1:]:
                samples.extend([np.zeros(round(.12*RATE), dtype="float32"), clip])
            sf.write(folder/f"speaker-{speaker}.wav", np.concatenate(samples), RATE)
            (folder/f"speaker-{speaker}.txt").write_text(" ".join(sample["text"] for _, sample in entries))
            digests.append((speaker, [(media, token((p["text"], p["audio"]))) for media, p in entries]))
        plan = dict(key=token(digests)[:20] if digests else "", sources=sources,
                    sourceCounts={s: len(ids) for s, ids in sources.items()})
        serialized = json.dumps(plan)
        if plan["key"]:
            directory = work/("speaker-library-"+plan["key"])
            (folder/"selection.json").write_text(serialized)
            try:
                folder.rename(directory)
            except OSError:
                if not (directory/"selection.json").is_file():
                    raise
        # Readers see either the prior complete snapshot or this one.
        with tempfile.NamedTemporaryFile(mode="w", dir=work, delete=False) as tmp:
            tmp.write(serialized)
        Path(tmp.name).replace(snapshot)
        return selection_report(plan, work)
    finally:
        shutil.rmtree(folder, ignore_errors=True)
