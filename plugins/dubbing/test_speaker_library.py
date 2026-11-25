import base64
import io
import json
import sqlite3
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import numpy as np
import soundfile as sf

import speaker_library as bank
from voice_samples import original_audio, transcribed_phrases, speech_windows
from types import SimpleNamespace


def sample(direction, text="phrase", seconds=3., quality=.82):
    wave = io.BytesIO()
    sf.write(wave, np.zeros(round(seconds*24000)), 24000, format="FLAC")
    return dict(vectors=[direction]*3, audio=base64.b64encode(wave.getvalue()).decode(),
                quality=quality, duration=seconds, text=text, language="en")


class References(unittest.TestCase):
    def test_old_raw_reference_samples_survive_a_separator_change_but_old_anchors_do_not(self):
        db = sqlite3.connect(":memory:")
        self.addCleanup(db.close)
        db.execute("CREATE TABLE recordings (media_id TEXT PRIMARY KEY,stamp TEXT,complete INTEGER,used REAL,voices BLOB)")
        for key, complete in (("sample", False), ("anchor", True), ("changed", False)):
            bank.save_record(db, key, "old-source", {"speaker": 3}, complete)
        self.assertEqual(bank.cached(db, "sample", "new", prior_sample_stamp="old-source"), {"speaker": 3})
        self.assertIsNone(bank.cached(db, "anchor", "new", prior_sample_stamp="old-source"))
        self.assertIsNone(bank.cached(db, "changed", "new", prior_sample_stamp="unrelated-source"))

    def test_assignment_requires_distinct_voices_and_independent_temporal_evidence(self):
        a, b = sample([1, 0]), sample([0, 1])
        self.assertEqual(set(bank.match_recording({"A": a, "B": b}, {"9": b, "3": a})), {"A", "B"})
        self.assertFalse(bank.match_recording({"A": a}, {"2": a, "4": a}))
        self.assertFalse(bank.match_recording({"A": a, "B": a}, {"4": a}))
        mixed = dict(a, vectors=[[1, 0], [1, 0], [0, 1]])
        self.assertFalse(bank.match_recording({"A": a}, {"4": mixed}))

    def test_complete_phrases_from_distinct_recordings_must_fit_the_prompt(self):
        anchor = sample([1, 0])
        candidates = [
            ("copy", sample([1, 0]), 1), ("long", sample([1, 0], "too long", 9), 1),
            ("one", sample([1, 0], "one"), .95), ("two", sample([1, 0], "two"), .85),
            ("three", sample([1, 0], "three"), .81),
        ]
        self.assertEqual([i for i, _ in bank.select_prompt(anchor, candidates)], ["one", "two"])

    def test_video_track_disposition_and_persistent_dubbed_audio_handler(self):
        for dubbed in [{"disposition": {"dub": 1}}, {"tags": {"handler_name": "Open EasyX Dubbed Audio"}}]:
            stream = {**dubbed, "index": 1}
            with patch("voice_samples.subprocess.check_output", return_value=json.dumps(
                    {"streams": [stream, {"index": 2, "disposition": {"original": 1}}], "format": {"duration": 10}})):
                self.assertEqual(original_audio("test.mp4"), (2, 10., False))
            with patch("voice_samples.subprocess.check_output", return_value=json.dumps(
                    {"streams": [stream], "format": {"duration": 10}})):
                self.assertIsNone(original_audio("test.mp4"))

    def test_adjacent_short_asr_segments_form_an_intact_solo_reference(self):
        chunks = [SimpleNamespace(start=a, end=b, text=t, avg_logprob=-.25, no_speech_prob=.02) for a,b,t in
                  [(0, 1, "one"), (1.05, 2.3, "two"), (4.1, 7, "outside")]]
        pieces = transcribed_phrases(chunks, np.zeros(3*24000))
        self.assertEqual(len(pieces), 1)
        self.assertEqual((len(pieces[0][0]), pieces[0][1]), (round(2.3*24000), "one two"))

    def test_short_movies_use_the_whole_recording_without_scouting(self):
        self.assertEqual(speech_windows("test", 1, 21.), [(0., 21.)])

    @patch("speaker_library.progress")
    @patch("speaker_library.original_audio", return_value=(1, 10, True))
    @patch("speaker_library.VoiceSampler")
    def test_cached_sources_resume_and_replaced_or_missing_recordings_drop_out(self, sampler_type, _track, _progress):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            work = base/"work"
            work.mkdir()
            def source(name):
                p = base/(name+".mp4")
                p.write_bytes(name.encode())
                return dict(mediaId=name, fingerprint="v1", source=str(p))
            current, other = source("current"), source("other")
            current["referenceVideos"] = [other]
            cues = [{"speaker": 0}]
            sampler = sampler_type.return_value
            sampler.from_work.return_value = {"0": sample([1, 0])}
            sampler.from_video.return_value = {"9": sample([1, 0], "other film")}
            directory, key = bank.prepare_references(current, base/"data", work, cues)
            self.assertTrue(key)
            self.assertEqual(json.loads((directory/"selection.json").read_text())["sources"], {"0": ["current", "other"]})
            self.assertEqual(sf.info(directory/"speaker-0.wav").frames, round((3+3+.12)*24000))
            self.assertEqual(bank.prepare_references(current, base/"data", work, cues), (directory, key))
            self.assertEqual(sampler.from_video.call_count, 1)
            # A new analysis assigns this speaker a different local ID. The
            # independent sample of the related recording remains reusable.
            sampler.from_work.return_value = {"1": sample([1, 0])}
            shifted, _ = bank.prepare_references(current, base/"data", work, [{"speaker": 1}], analysis="new-turns")
            self.assertEqual(json.loads((shifted/"selection.json").read_text())["sources"], {"1": ["current", "other"]})
            self.assertEqual(sampler.from_work.call_count, 2)
            self.assertEqual(sampler.from_video.call_count, 1)
            sampler.from_work.return_value = {"0": sample([1, 0])}
            Path(other["source"]).write_bytes(b"unrelated audio at the same location")
            sampler.from_video.return_value = {"9": sample([0, 1], "another performer")}
            self.assertEqual(bank.prepare_references(current, base/"data", work, cues), (work, ""))
            self.assertEqual(sampler.from_video.call_count, 2)
            Path(other["source"]).unlink()
            self.assertEqual(bank.prepare_references(current, base/"data", work, cues), (work, ""))

    @patch("speaker_library.progress")
    @patch("speaker_library.original_audio", return_value=(1, 10, True))
    @patch("speaker_library.VoiceSampler")
    def test_cold_and_warm_candidates_are_evaluated_across_the_whole_list(self, sampler_type, _track, _progress):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            work1, work2 = base/"one", base/"two"
            work1.mkdir()
            work2.mkdir()
            entries = []
            for i in range(11):
                source = base/f"{i}.mp4"
                source.write_bytes(str(i).encode())
                entries.append(dict(mediaId=str(i), fingerprint="v1", source=str(source)))
            sampler = sampler_type.return_value
            sampler.from_work.return_value = {"0": sample([1, 0])}
            sampler.from_video.side_effect = lambda s: {"1": sample([1, 0], "last film")} if Path(s) == Path(entries[-1]["source"]).resolve() else {}
            current = dict(entries[0], referenceVideos=[entries[-1]])
            bank.prepare_references(current, base, work1, [{"speaker": 0}])
            current["referenceVideos"] = entries[1:]
            dest, _ = bank.prepare_references(current, base, work2, [{"speaker": 0}])
            self.assertEqual(sampler.from_video.call_count, len(entries)-1)
            self.assertEqual(json.loads((dest/"selection.json").read_text())["sources"], {"0": ["0", "10"]})

    @patch("speaker_library.progress")
    @patch("speaker_library.original_audio", return_value=(1, 10, True))
    @patch("speaker_library.VoiceSampler")
    def test_first_render_includes_the_seventh_match_and_skips_reanalysis_on_another_job(self, sampler_type, _track, _progress):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            work, newer_work = base/"work", base/"new-work"
            work.mkdir()
            newer_work.mkdir()
            entries = []
            for i in range(8):
                path = base/f"{i}.mp4"
                path.write_bytes(str(i).encode())
                entries.append(dict(mediaId=str(i), fingerprint="v1", source=str(path)))
            job = dict(entries[0], referenceVideos=entries[1:])
            sampler = sampler_type.return_value
            sampler.from_work.return_value = {"0": sample([1, 0])}
            sampler.from_video.side_effect = lambda s: {"7": sample([1, 0], "valid voice")} if Path(s).stem == "7" else {}
            directory, key = bank.prepare_references(job, base/"data", work, [{"speaker": 0}])
            self.assertEqual(json.loads((directory/"selection.json").read_text())["sources"], {"0": ["0", "7"]})
            self.assertEqual(bank.prepare_references(job, base/"data", newer_work, [{"speaker": 0}])[1], key)
            self.assertEqual(sampler.from_video.call_count, 7)


if __name__ == "__main__":
    unittest.main()
