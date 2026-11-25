"""Regression coverage for real-world invalid transcripts and silent cloned voices."""
import importlib.util
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import sys
import unittest
from unittest.mock import Mock, patch

REQUIRED = all(importlib.util.find_spec(key) for key in ("torch", "scipy", "numpy", "soundfile"))
if REQUIRED:
    import numpy as np
    import soundfile as sf
    import speech_review
    import voice_samples
    import voices


@unittest.skipUnless(REQUIRED, "requires the optional dubbing Python environment")
class SpeechRecoveryTests(unittest.TestCase):
    def test_unvoiced_guesses_cannot_displace_cached_phrases(self):
        with TemporaryDirectory() as root:
            work = Path(root)
            sf.write(work/"mix.wav", np.zeros(32000), 16000)
            sf.write(work/"zero.flac", np.zeros(16000), 16000)
            sf.write(work/"voice.flac", np.ones(16000)*.1, 16000)
            cues = [dict(text="Guess", language="en", start=0., end=1., speaker=0, clip="zero.flac"),
                    dict(text="Hello", language="en", start=1., end=2., speaker=1, clip="voice.flac")]
            (work/"speakers.json").write_text(json.dumps(cues))
            (work/"translation-fr.json").write_text('["old zero","old one"]')
            with patch.object(speech_review, "whisper_model", side_effect=AssertionError("silent input")):
                verified, stage = speech_review.review_transcript(cues, work, work)
                self.assertEqual(verified, cues[1:])
                self.assertNotEqual(stage, work)
                self.assertEqual(json.loads((stage/"speakers.json").read_text()), verified)
                self.assertEqual(json.loads((work/"speakers.json").read_text()), cues)
                self.assertFalse((stage/"translation-fr.json").exists())
                self.assertEqual(json.loads((work/"translation-fr.json").read_text()), ["old zero", "old one"])
                self.assertEqual(speech_review.review_transcript(cues, work, work), (verified, stage))

    def test_visible_script_mismatch_requires_uncertainty_and_preserves_code_switches(self):
        cue = dict(text="東京", language="en", languageProbability=.25)
        self.assertTrue(speech_review.suspect_text(cue))
        self.assertFalse(speech_review.suspect_text(dict(cue, language="ja")))
        self.assertFalse(speech_review.suspect_text(dict(cue, languageProbability=.95)))
        self.assertFalse(speech_review.suspect_text(dict(cue, text="Meet in 東京")))
        self.assertTrue(speech_review.suspect_text(dict(cue, text="a\ufffdb")))

    def test_heard_but_unrecoverable_utterance_stops_instead_of_publishing_silence(self):
        with TemporaryDirectory() as root:
            work = Path(root)
            sf.write(work/"mix.wav", np.ones(16000)*.1, 16000)
            sf.write(work/"zero.flac", np.zeros(16000), 16000)
            cue = dict(text="Guess", language="en", speaker=0, start=0., end=1., clip="zero.flac")
            model = Mock()
            model.transcribe.return_value = ([], SimpleNamespace(language="en", language_probability=.95))
            with patch.object(speech_review, "speech_spans", side_effect=[[], [(10, 10000)]]), \
                 patch.object(speech_review, "whisper_model", return_value=model):
                with self.assertRaisesRegex(ValueError, "reliable source transcript"):
                    speech_review.review_transcript([cue], work, work)
            self.assertFalse(list(work.glob("verified-*/speakers.json")))

    def test_recover_source_words_from_the_same_solo_voice_and_keep_its_reference_separate(self):
        with TemporaryDirectory() as root:
            work = Path(root)
            samples = np.sin(2*np.pi*np.arange(16000)*200/16000)*.1
            sf.write(work/"mix.wav", samples, 16000)
            sf.write(work/"zero.flac", np.zeros(16000), 16000)
            cue = dict(text="Guess", language="en", speaker=2, start=0., end=1., clip="zero.flac")
            model = Mock()
            model.transcribe.return_value = ([SimpleNamespace(text="Actual speech", avg_logprob=-.15, no_speech_prob=.02)],
                                             SimpleNamespace(language="en", language_probability=.97))
            with patch.object(speech_review, "speech_spans", side_effect=[[], [(10, 9000)]]), \
                 patch.object(speech_review, "whisper_model", return_value=model), \
                 patch("dialogue.speaker_references") as references:
                recovered, stage = speech_review.review_transcript([cue], work, work)
            self.assertEqual(recovered[0]["text"], "Actual speech")
            self.assertEqual(recovered[0]["speaker"], 2)
            self.assertTrue((work/recovered[0]["clip"]).is_file())
            references.assert_called_once_with(recovered, work, stage)

    def test_only_missing_or_empty_cached_translations_are_generated(self):
        with TemporaryDirectory() as root:
            path = Path(root)/"translation-fr.json"
            path.write_text(json.dumps(["Bonjour", "  ", None]))
            cues = [dict(language="en", text=t) for t in ["Hello", "Evening", "Thanks"]]
            with patch.dict(sys.modules, {"transformers": Mock()}), patch.object(voices, "model_path"), \
                 patch.object(voices, "device", return_value="cpu"), patch.object(voices, "load_translation_model"), \
                 patch.object(voices, "translate_batch", return_value=["Bonsoir","Merci"]) as generate:
                self.assertEqual(voices.translate(cues, "fr", path), ["Bonjour","Bonsoir","Merci"])
                self.assertEqual(generate.call_args.args[2], ["Evening","Thanks"])
                self.assertEqual(json.loads(path.read_text()), ["Bonjour","Bonsoir","Merci"])

    def test_genuinely_untranslatable_speech_does_not_become_an_empty_translation(self):
        with TemporaryDirectory() as root:
            path = Path(root)/"translation-fr.json"
            cues = [dict(language="en", text="Hello", start=.5)]
            transformers = Mock()
            tokenizer = transformers.AutoTokenizer.from_pretrained.return_value
            tokenizer.return_value.to.return_value = {}
            tokenizer.batch_decode.return_value = [" "]
            with patch.dict(sys.modules, {"transformers": transformers}), patch.object(voices, "model_path"), \
                 patch.object(voices, "device", return_value="cpu"), patch.object(voices, "load_translation_model"), \
                 patch.object(voices, "translate_batch", return_value=[""]):
                with self.assertRaisesRegex(ValueError, "en to fr produced no text at 0.50s"):
                    voices.translate(cues, "fr", path)
            self.assertFalse(path.exists())

    def test_silent_reference_is_replaced_only_by_the_same_speaker(self):
        with TemporaryDirectory() as root:
            work = Path(root)
            selected = work/"selected"
            selected.mkdir()
            sf.write(selected/"speaker-1.wav", np.zeros(8000), 16000)
            (selected/"speaker-1.txt").write_text("Old")
            sf.write(work/"speaker-2.wav", np.ones(8000)*.1, 16000)
            (work/"speaker-2.txt").write_text("Other person")
            with self.assertRaisesRegex(ValueError, "speaker 2"):
                voices.speaker_reference(1, [selected, work], 3.)
            sf.write(work/"speaker-1.wav", np.ones(8000)*.1, 16000)
            (work/"speaker-1.txt").write_text("Same speaker")
            self.assertEqual(voices.speaker_reference(1, [selected, work], 3.)[2], "Same speaker")

    def test_last_voice_retry_can_use_a_different_solo_recording_of_the_same_person(self):
        with TemporaryDirectory() as root:
            work = Path(root)
            cue = dict(language="en", start=0., end=3., speaker=0, clip="solo.flac")
            cues = [dict(cue, speaker=1), dict(cue, overlapping=True)]
            audio = np.ones(48000, dtype="float32")*.1
            sf.write(work/"solo.flac", audio, 16000)
            with patch.object(speech_review, "speech_spans", return_value=[(0, 32000)]), \
                 patch.object(voice_samples, "align_clone_reference", return_value=(audio, "Hello")) as align:
                self.assertIsNone(voice_samples.alternate_clone_reference(None, cues, work, 0))
                _, rate, words = voice_samples.alternate_clone_reference(None, [*cues, cue], work, 0)
                self.assertEqual((rate, words), (16000, "Hello"))
                self.assertEqual(align.call_count, 1)

    def test_empty_voice_retries_the_same_words_and_never_caches_silence(self):
        for successful in [True, False]:
            with self.subTest(successful=successful), TemporaryDirectory() as root:
                work = Path(root)
                out = work/"voice-fr"
                out.mkdir()
                wave = np.ones(12000, dtype="float32")*.1
                sf.write(work/"mix.wav", wave, 16000)
                sf.write(work/"speaker-2.wav", wave, 16000)
                (work/"speaker-2.txt").write_text("Hello")
                model = Mock(sampling_rate=16000)
                prompt = SimpleNamespace(ref_text="Hello", ref_audio_tokens=Mock(shape=(1, 25)))
                fixed = SimpleNamespace(ref_text="Aligned", ref_audio_tokens=Mock(shape=(1, 25)))
                model.create_voice_clone_prompt.side_effect = [prompt, fixed]
                model.duration_estimator.estimate_duration.return_value = 25
                model.audio_tokenizer.config.frame_rate = 25
                model.generate.side_effect = [[np.zeros(0)], [wave], [wave]]
                cue = dict(text="Hello", start=0., end=.75, language="en", speaker=2)
                with patch.dict(sys.modules, {"omnivoice": Mock(), "faster_whisper": Mock()}), \
                     patch.object(voices, "load_voice_model", return_value=model), patch.object(voices, "model_path"), \
                     patch("voice_samples.align_clone_reference", return_value=(wave, "Aligned")), \
                     patch.object(voices, "verifies_words", side_effect=[False, successful]):
                    if successful:
                        voices.synthesize([cue], ["Bonjour"], "fr", work, out, [0], "cpu")
                    else:
                        with self.assertRaisesRegex(ValueError, "intelligible fr speech"):
                            voices.synthesize([cue], ["Bonjour"], "fr", work, out, [0], "cpu")
                self.assertEqual((out/"0.wav").is_file(), successful)
                self.assertFalse((out/"0.partial.wav").exists())
                self.assertEqual([c.kwargs["voice_clone_prompt"] for c in model.generate.call_args_list],
                                 [prompt, fixed, fixed])
                self.assertTrue(all(c.kwargs["text"] == "Bonjour" for c in model.generate.call_args_list))

    def test_an_abnormally_short_first_take_is_kept_only_when_its_words_are_corroborated(self):
        french = "Bonsoir les amis !"
        chinese = "我今天要去图书馆"
        cases = [
            ("fr", french, .64, ["Tout est fini", french], 2),
            ("fr", french, .64, [french], 1),
            ("zh", chinese, .64, ["再见", chinese], 2),
            ("fr", french, 1.2, [], 1),
            ("fr", "Oui !", .64, [], 1),
        ]
        for language, target, first_duration, heard, takes in cases:
            with self.subTest(target=target, heard=heard), TemporaryDirectory() as root:
                work = Path(root)
                out = work/"voices"
                out.mkdir()
                rate = 16000
                audio = np.full(2*rate, .1, dtype="float32")
                sf.write(work/"mix.wav", audio, rate)
                sf.write(work/"speaker-0.wav", audio, rate)
                (work/"speaker-0.txt").write_text("Good evening")
                model = Mock(sampling_rate=rate)
                model.create_voice_clone_prompt.return_value = SimpleNamespace(
                    ref_text="Good evening", ref_audio_tokens=Mock(shape=(1, 25)))
                model.duration_estimator.estimate_duration.return_value = 45
                model.audio_tokenizer.config.frame_rate = 25
                model.generate.side_effect = [[audio[:round(first_duration*rate)]], [audio[:round(1.6*rate)]]]
                whisper = Mock()
                transcribe = whisper.WhisperModel.return_value.transcribe
                transcribe.side_effect = [([SimpleNamespace(text=text, avg_logprob=-.3, no_speech_prob=.1)], None)
                                          for text in heard]
                cue = dict(text="Good evening", language="en", start=0., end=1.8, speaker=0)
                with patch.dict(sys.modules, {"omnivoice": Mock(), "faster_whisper": whisper}), \
                     patch.object(voices, "model_path"), patch.object(voices, "load_voice_model", return_value=model), \
                     patch.object(voice_samples, "align_clone_reference", return_value=None):
                    voices.synthesize([cue], [target], language, work, out, [0], "cpu")
                self.assertEqual(model.generate.call_count, takes)
                self.assertEqual(transcribe.call_count, len(heard))
                self.assertEqual(whisper.WhisperModel.call_count, int(bool(heard)))
                self.assertEqual(sf.info(out/"0.wav").frames, round((first_duration if takes == 1 else 1.6)*rate))


if __name__ == "__main__":
    unittest.main()
