import tempfile
import unittest
from contextlib import nullcontext
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

import worker


def whisper_chunk(language, confidence, text, *, forced=False):
    segments = [SimpleNamespace(start=1, end=2, text=text)] if text else []
    info = SimpleNamespace(language=language, language_probability=confidence,
                           all_language_probs=None if forced else [(language, confidence)])
    return iter(segments), info


class QueueOrderTests(unittest.TestCase):
    def test_next_job_reads_saved_order_and_ignores_work_in_progress(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(worker, "DB_PATH", Path(tmp)/"library.sqlite"):
            with worker.connect() as con:
                con.executescript("""
                    CREATE TABLE settings(key PRIMARY KEY,value_json);
                    CREATE TABLE media(id,kind,missing,added_at,modified_at);
                    CREATE TABLE subtitle_jobs(media_id,fingerprint,requested_languages_json,source_language,attempts,status);
                    INSERT INTO media VALUES ('old','video',0,'2024','2026'),('new','video',0,'2025','2023'),('busy','video',0,'2026','2022');
                    INSERT INTO subtitle_jobs VALUES ('old','','[]','',0,'queued'),('new','','[]','',0,'queued'),('busy','','[]','',0,'running');
                """)
            self.assertEqual(worker.next_job()["id"], "old")
            with worker.connect() as con:
                con.execute("""INSERT INTO settings VALUES ('subtitles','{"oldestFirst":false}')""")
            self.assertEqual(worker.next_job()["id"], "new")
            with worker.connect() as con:
                con.execute("""UPDATE settings SET value_json='{"oldestFirst":true}'""")
            self.assertEqual(worker.next_job()["id"], "old")


class DetectionTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.media = {"id": "video", "size": 42, "modified_at": "today"}
        self.model = Mock()
        self.whisper = Mock(return_value=self.model)
        self.report = Mock()
        for mock in [patch.object(worker, "SUBTITLE_ROOT", self.root), patch.object(worker, "CHUNK_SECONDS", 10),
                     patch.object(worker, "report_progress", self.report), patch.object(worker, "ensure_dependency"),
                     patch.object(worker, "extract_audio"), patch.dict("sys.modules", {"faster_whisper": SimpleNamespace(WhisperModel=self.whisper)})]:
            mock.start()
            self.addCleanup(mock.stop)

    def transcribe(self, seconds):
        return worker.transcribe(self.media, self.root / "sample.mp4", seconds)

    def test_ignores_silence_and_weak_guesses_then_keeps_real_confidence(self):
        self.model.transcribe.side_effect = [
            whisper_chunk("en", .99, ""), whisper_chunk("en", .31, "Hmm"), whisper_chunk("sv", .91, "Hej"),
            whisper_chunk("sv", 1, "Igen", forced=True),
        ]
        result = self.transcribe(40)
        self.assertEqual(result[:2], ("sv", .91))
        self.assertEqual([call.kwargs["language"] for call in self.model.transcribe.call_args_list], [None, None, None, "sv"])
        self.assertEqual(len(result[2]), 3)
        self.whisper.reset_mock()
        self.report.reset_mock()
        self.assertEqual(self.transcribe(40), result)
        self.whisper.assert_not_called()
        self.assertEqual([call.args[2] for call in self.report.call_args_list], [20, 40, 60, 80])

    def test_no_speech_and_unconfirmed_speech_have_no_invented_source(self):
        self.model.transcribe.side_effect = [whisper_chunk("en", .99, ""), whisper_chunk("en", .22, "Hmm")]
        self.assertEqual(self.transcribe(10), ("", 0, []))
        language, confidence, cues = self.transcribe(20)
        self.assertEqual((language, confidence), ("und", 0))
        self.assertEqual(cues[0]["text"], "Hmm")

    def test_resumes_old_chunks_without_treating_a_forced_score_as_detection(self):
        work = self.root / "video" / "work"
        work.mkdir(parents=True)
        for index, confidence in enumerate([.27, 1]):
            worker.save_transcript(work / f"chunk-{index:06d}.json", {
                "fingerprint": worker.fingerprint(self.media), "model": worker.WHISPER_MODEL, "chunkSeconds": 10,
                "language": "en", "probability": confidence, "cues": [{"start": index * 10, "end": index * 10 + 1, "text": "Hmm"}],
            })
        self.model.transcribe.side_effect = [whisper_chunk("de", .89, "Hallo"), whisper_chunk("de", 1, "Welt", forced=True)]
        self.assertEqual(self.transcribe(20)[:2], ("de", .89))
        self.assertEqual([call.kwargs["language"] for call in self.model.transcribe.call_args_list], [None, "de"])


class TranslationTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.video = {"id": "clip", "size": 40, "modified_at": "today", "duration": 20, "relative_path": "sample.mp4"}
        self.original = self.root / "clip" / "original.json"
        self.original.parent.mkdir()
        (self.root / "sample.mp4").touch()
        for mock in [patch.object(worker, "DB_PATH", self.root / "library.sqlite"), patch.object(worker, "MEDIA_ROOT", self.root),
                     patch.object(worker, "SUBTITLE_ROOT", self.root), patch.object(worker, "has_audio", return_value=True),
                     patch.object(worker, "ensure_dependency")]:
            mock.start()
            self.addCleanup(mock.stop)
        with worker.connect() as con:
            con.executescript("""
                CREATE TABLE media(id,kind,missing,size,modified_at,duration);
                CREATE TABLE subtitle_jobs(media_id PRIMARY KEY,fingerprint,requested_languages_json,status,progress,phase,
                    target_language,source_language,source_language_probability,attempts,last_error,completed_at,updated_at);
                CREATE TABLE subtitle_tracks(id,media_id,language,label,origin,source_language,updated_at,PRIMARY KEY(media_id,id));
                INSERT INTO media VALUES ('clip','video',0,40,'today',20);
            """)

    def test_upgrade_requeues_only_formerly_unsupported_sources(self):
        with worker.connect() as con:
            con.execute("""INSERT INTO subtitle_jobs(media_id,status,last_error,attempts)
                        VALUES ('old','error',?,3),('still-unsupported','error',?,3)""",
                        ("translation from detected language 'sv' is not supported yet", "translation from detected language 'la' is not supported yet"))
        worker.resume_jobs()
        with worker.connect() as con:
            self.assertEqual(con.execute("SELECT status,attempts FROM subtitle_jobs WHERE media_id='old'").fetchone()[:], ("queued", 0))
            self.assertEqual(con.execute("SELECT status FROM subtitle_jobs WHERE media_id='still-unsupported'").fetchone()[0], "error")

    def test_redetects_a_weak_cached_original_once_when_translations_are_requested(self):
        cues = [{"start": 1, "end": 2, "text": "English guess"}]
        worker.save_transcript(self.original, {"fingerprint": worker.fingerprint(self.video), "language": "en",
                                               "probability": .24, "cues": cues})
        model = Mock()
        model.transcribe.side_effect = [whisper_chunk("fr", .93, "Bonjour"), whisper_chunk("fr", 1, "Encore", forced=True)]
        with patch.object(worker, "extract_audio"), patch.object(worker, "CHUNK_SECONDS", 10), \
             patch.dict("sys.modules", {"faster_whisper": SimpleNamespace(WhisperModel=Mock(return_value=model))}):
            worker.discover([])
            worker.process(self.video, [])
            model.transcribe.assert_not_called()
            worker.discover(["fr"])
            worker.process(self.video, ["fr"])
            self.assertEqual([call.kwargs["language"] for call in model.transcribe.call_args_list], [None, "fr"])
            corrected = worker.load_transcript(self.original, {"detectionVersion": 2})
            self.assertEqual((corrected["language"], corrected["probability"]), ("fr", .93))
            self.assertIn("Bonjour", (self.original.parent / "original.vtt").read_text())
            worker.process(self.video, ["fr"])
            self.assertEqual(model.transcribe.call_count, 2)

    def test_redetected_silence_drops_obsolete_tracks_and_keeps_manual_captions(self):
        cues = [{"start": 1, "end": 2, "text": "Wrong guess"}]
        worker.save_transcript(self.original, {"fingerprint": worker.fingerprint(self.video), "language": "en",
                                               "probability": .24, "cues": cues})
        worker.write_track("clip", "original", "en", "Original", "original", "en", cues)
        worker.write_track("clip", "fr", "fr", "French", "generated", "en", cues)
        worker.write_track("clip", "manual-it", "it", "Italian", "manual", "it", cues)
        model = Mock()
        model.transcribe.side_effect = [whisper_chunk("en", .99, "")]
        with patch.object(worker, "extract_audio"), patch.dict("sys.modules", {"faster_whisper": SimpleNamespace(WhisperModel=Mock(return_value=model))}):
            worker.discover(["fr"])
            worker.process(self.video, ["fr"])
        with worker.connect() as con:
            self.assertEqual(con.execute("SELECT status,source_language FROM subtitle_jobs").fetchone()[:], ("no_speech", ""))
            self.assertEqual([row[0] for row in con.execute("SELECT id FROM subtitle_tracks")], ["manual-it"])
        self.assertTrue((self.original.parent / "manual-it.vtt").is_file())

    def test_lost_transcript_rebuilds_translations_even_if_source_language_is_unchanged(self):
        old = [{"start": 1, "end": 2, "text": "Old cues"}]
        worker.write_track("clip", "fr", "fr", "French", "generated", "en", old)
        self.original.write_text("{broken")
        model = Mock()
        model.transcribe.side_effect = [whisper_chunk("en", .98, "New transcription")]
        with patch.object(worker, "extract_audio"), patch.object(worker, "translate") as translate, \
             patch.dict("sys.modules", {"faster_whisper": SimpleNamespace(WhisperModel=Mock(return_value=model))}):
            worker.discover(["fr"])
            worker.process(self.video, ["fr"])
        cues, source, _, targets, _, completed = translate.call_args.args
        self.assertEqual((source, targets, completed), ("en", ["fr"], 0))
        self.assertEqual(cues[0]["text"], "New transcription")

    def test_reuses_remaining_original_when_redetection_confirms_legacy_language(self):
        cues = [{"start": 1, "end": 2, "text": "Bonjour"}, {"start": 12, "end": 13, "text": "Encore"}]
        worker.save_transcript(self.original, {"fingerprint": worker.fingerprint(self.video), "language": "fr",
                                               "probability": 1, "cues": cues})
        model = Mock()
        model.transcribe.side_effect = [whisper_chunk("fr", .90, "Bonjour")]
        with patch.object(worker, "extract_audio"), patch.object(worker, "CHUNK_SECONDS", 10), \
             patch.dict("sys.modules", {"faster_whisper": SimpleNamespace(WhisperModel=Mock(return_value=model))}):
            worker.discover(["fr"])
            worker.process(self.video, ["fr"])
            model.transcribe.assert_called_once()
            corrected = worker.load_transcript(self.original, {"detectionVersion": 2})
            self.assertEqual(corrected["cues"], cues)
            self.assertEqual(corrected["probability"], .9)

    def test_generates_each_missing_target_once_and_reuses_cached_tracks_after_reconfiguration(self):
        video, root = self.video, self.root
        cues = [{"start": i, "end": i+.8, "text": f"Hej {i}"} for i in range(9)]
        worker.save_transcript(root / "clip" / "original.json", {"fingerprint": worker.fingerprint(video), "language": "sv", "probability": .92, "cues": cues})
        tokenizer = Mock()
        tokenizer.side_effect = lambda texts, **kwargs: {"texts": texts}
        tokenizer.convert_tokens_to_ids.side_effect = lambda tag: tag
        tokenizer.batch_decode.side_effect = lambda output, **kwargs: output
        model = Mock()
        model.generate.side_effect = lambda texts, forced_bos_token_id, **kwargs: [f"{forced_bos_token_id} {text}" for text in texts]
        tokenizer_factory = Mock(from_pretrained=Mock(return_value=tokenizer))
        modules = {"torch": SimpleNamespace(set_num_threads=lambda _: None, inference_mode=nullcontext),
                   "transformers": SimpleNamespace(AutoTokenizer=tokenizer_factory, AutoModelForSeq2SeqLM=Mock(from_pretrained=Mock(return_value=model)))}
        with patch.dict("sys.modules", modules), \
             patch.object(worker, "transcribe", side_effect=AssertionError("Original should be reused")), \
             patch.object(worker, "report_progress", wraps=worker.report_progress) as progress:
            worker.discover(["fr", "en", "fr"])
            worker.process(video, ["fr", "en", "fr"])
            self.assertEqual(tokenizer_factory.from_pretrained.call_args.kwargs["src_lang"], "swe_Latn")
            self.assertTrue((root / "clip/original.vtt").is_file())
            self.assertIn("fra_Latn Hej", (root / "clip/fr.vtt").read_text())
            self.assertIn("eng_Latn Hej", (root / "clip/en.vtt").read_text())
            self.assertEqual([call.kwargs["forced_bos_token_id"] for call in model.generate.call_args_list],
                             ["fra_Latn", "fra_Latn", "eng_Latn", "eng_Latn"])
            french_progress = [call.args[2] for call in progress.call_args_list if len(call.args) == 6 and call.args[5] == "fr"]
            self.assertTrue(any(80 < value < 89.5 for value in french_progress))
            worker.discover(["en", "fr"])
            with worker.connect() as con:
                self.assertEqual(con.execute("SELECT status,phase,target_language FROM subtitle_jobs").fetchone()[:], ("complete", "", ""))
            progress.reset_mock()
            model.reset_mock()
            worker.discover(["de", "fr"])
            worker.process(video, ["de", "fr"])
            self.assertEqual([call.kwargs["forced_bos_token_id"] for call in model.generate.call_args_list], ["deu_Latn", "deu_Latn"])
            self.assertTrue(any(call.args[1:] == ("translating", 89.5, "sv", .92, "de") for call in progress.call_args_list))
            with worker.connect() as con:
                self.assertEqual([row[0] for row in con.execute("SELECT id FROM subtitle_tracks ORDER BY id")], ["de", "fr", "original"])

            # The selected target already exists as the original spoken-language track.
            worker.save_transcript(root / "clip" / "original.json", {"fingerprint": worker.fingerprint(video), "language": "fr", "probability": .96, "cues": cues})
            worker.discover(["fr"])
            model.reset_mock()
            worker.process(video, ["fr"])
            model.generate.assert_not_called()
            with worker.connect() as con:
                self.assertEqual([row[0] for row in con.execute("SELECT id FROM subtitle_tracks")], ["original"])


if __name__ == "__main__":
    unittest.main()
