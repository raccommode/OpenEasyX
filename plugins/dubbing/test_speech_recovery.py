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
    def test_changed_isolated_audio_cannot_reuse_a_translation_or_clone_by_cue_number(self):
        with TemporaryDirectory() as root:
            work = Path(root)
            sf.write(work/"mix.wav", np.full(16000, .1), 16000)
            cue = dict(text="Hello", language="en", start=0., end=1., speaker=0, clip="voice.flac")
            sf.write(work/cue["clip"], np.full(16000, .1), 16000)
            original, first = speech_review.review_transcript([cue], work, work)
            (first/"translation-fr.json").write_text('["Bonjour"]')
            self.assertEqual(original, [cue])
            self.assertEqual(speech_review.review_transcript([cue], work, work)[1], first)
            sf.write(work/cue["clip"], np.full(16000, .2), 16000)
            unchanged_text, second = speech_review.review_transcript([cue], work, work)
            self.assertEqual(unchanged_text, original)
            self.assertNotEqual(first, second)
            self.assertFalse((second/"translation-fr.json").exists())

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

    def test_unverified_speech_preserves_its_time_and_identity_and_other_speakers_continue(self):
        with TemporaryDirectory() as root:
            work = Path(root)
            wave = np.sin(2*np.pi*np.arange(32000)*200/16000)*.1
            sf.write(work/"mix.wav", wave, 16000)
            sf.write(work/"zero.flac", np.zeros(16000), 16000)
            sf.write(work/"other.flac", wave[:16000], 16000)
            cue = dict(text="Guess", language="nn", speaker=0, start=0., end=1., clip="zero.flac")
            other = dict(text="Hello", language="en", speaker=1, start=1., end=2., clip="other.flac")
            model = Mock()
            model.transcribe.return_value = ([], SimpleNamespace(language="en", language_probability=.95))
            with patch.object(speech_review, "speech_spans", return_value=[(10, 10000)]), \
                 patch.object(speech_review, "whisper_model", return_value=model), \
                 patch("dialogue.speaker_references") as references:
                verified, stage = speech_review.review_transcript([cue, other], work, work)
                self.assertEqual(verified, [dict(cue, text="", preserveOriginal="unverified-source"), other])
                self.assertEqual(speech_review.review_transcript([cue, other], work, work), (verified, stage))
                references.assert_not_called()
                for call in model.transcribe.call_args_list:
                    self.assertIsNone(call.kwargs.get("language"))

    def test_transient_vad_on_background_does_not_create_a_preserved_line(self):
        with TemporaryDirectory() as root:
            work = Path(root)
            samples = .01*np.sin(2*np.pi*np.arange(16000)*200/16000)
            sf.write(work/"mix.wav", samples, 16000)
            sf.write(work/"zero.flac", np.zeros(16000), 16000)
            cue = dict(text="Guess", language="en", speaker=0, start=0., end=1., clip="zero.flac")
            model = Mock()
            model.transcribe.return_value = ([], SimpleNamespace(language="en", language_probability=.95))
            with patch.object(speech_review, "whisper_model", return_value=model), \
                 patch.object(speech_review, "speech_spans", side_effect=[[(500, 1100)], [(100, 5000)]]), \
                 patch("dialogue_repair.event_classifier", return_value=lambda audio: (0., .95, .01)):
                verified, _ = speech_review.review_transcript([cue], work, work)
            self.assertEqual(verified, [])

    def test_quieter_microphone_with_speech_survives_an_erased_isolate(self):
        with TemporaryDirectory() as root:
            work = Path(root)
            t = np.arange(16000)/16000
            background, quieter = .4*np.sin(2*np.pi*500*t), .03*np.sin(2*np.pi*180*t)
            sf.write(work/"mix.wav", np.column_stack([background, quieter]), 16000, subtype="FLOAT")
            sf.write(work/"zero.flac", np.zeros(16000), 16000)
            cue = dict(text="Guess", language="en", speaker=2, start=0., end=1., clip="zero.flac")
            model = Mock()
            model.transcribe.return_value = ([], SimpleNamespace(language="en", language_probability=.95))
            classifier = Mock(side_effect=lambda samples: (.7,0.,0.) if np.max(samples) < .1 else (0.,.8,0.))
            with patch.object(speech_review, "speech_spans", return_value=[]), \
                 patch("dialogue_repair.event_classifier", return_value=classifier), \
                 patch.object(speech_review, "whisper_model", return_value=model):
                verified, _ = speech_review.review_transcript([cue], work, work)
            self.assertEqual(verified, [dict(cue, text="", preserveOriginal="unverified-source")])
            self.assertEqual(classifier.call_count, 2)

    def test_recover_source_words_from_the_same_solo_voice_and_keep_its_reference_separate(self):
        with TemporaryDirectory() as root:
            work = Path(root)
            samples = np.sin(2*np.pi*np.arange(12*16000)*200/16000)*.1
            sf.write(work/"mix.wav", samples, 16000)
            sf.write(work/"zero.flac", np.zeros(16000), 16000)
            cue = dict(text="Guess", language="nn", speaker=2, start=5., end=6., clip="zero.flac")
            model = Mock()
            model.transcribe.side_effect = [self.words(3.54, 4.32, " Hello"), self.words(5.08, 5.83, " Hello")]
            with patch.object(speech_review, "whisper_model", return_value=model), \
                 patch("dialogue.speaker_references") as references:
                recovered, stage = speech_review.review_transcript([cue], work, work)
            self.assertEqual((recovered[0]["text"], recovered[0]["language"]), ("Hello", "en"))
            self.assertEqual(recovered[0]["speaker"], 2)
            self.assertTrue((work/recovered[0]["clip"]).is_file())
            references.assert_called_once_with(recovered, work, stage)

    @staticmethod
    def words(start, end, text=" Wait", probability=.9):
        word = SimpleNamespace(start=start, end=end, word=text, probability=probability)
        return ([SimpleNamespace(words=[word], avg_logprob=-.2, no_speech_prob=.02)],
                SimpleNamespace(language="en", language_probability=.9))

    def test_faint_turn_recovers_a_real_short_word_when_separation_erased_it(self):
        with TemporaryDirectory() as root:
            work = Path(root)
            sf.write(work/"mix.wav", np.full(12*16000, .03), 16000)
            sf.write(work/"faint.flac", np.full(6400, .00007), 16000)
            cue = dict(text="Guess", language="en", languageProbability=.35, speaker=2,
                       start=5., end=5.4, clip="faint.flac")
            model = Mock()
            model.transcribe.side_effect = [self.words(3.54, 3.82), self.words(5.08, 5.32)]
            with patch.object(speech_review, "whisper_model", return_value=model), patch("dialogue.speaker_references"):
                verified, stage = speech_review.review_transcript([cue], work, work)
            self.assertEqual(len(verified), 1)
            self.assertEqual((verified[0]["text"], verified[0]["speaker"]), ("Wait", 2))
            self.assertEqual(sf.info(work/verified[0]["clip"]).frames, 6400)
            self.assertIn("verified-speech-v3-", stage.name)

    def test_context_excludes_neighbouring_and_zero_duration_words_even_on_a_nonzero_clip(self):
        with TemporaryDirectory() as root:
            work = Path(root)
            sf.write(work/"mix.wav", np.full(12*16000, .03), 16000)
            sf.write(work/"faint.flac", np.full(6400, .00007), 16000)
            cue = dict(text="Guess", language="en", languageProbability=.4, speaker=2,
                       start=5., end=5.4, clip="faint.flac")
            model = Mock()
            # The first word straddles two turns but belongs to the next
            # speaker. The other is a Whisper word collapsed to one timestamp.
            model.transcribe.side_effect = [self.words(3.78, 4.13), self.words(5.2, 5.2)]
            with patch.object(speech_review, "whisper_model", return_value=model):
                verified, _ = speech_review.review_transcript([cue], work, work)
            self.assertEqual(verified, [])

    def test_impossible_rate_in_loud_overlap_does_not_borrow_another_speakers_word(self):
        self.assertFalse(speech_review.impossible_word_rate("Yes, sir!", .23))
        self.assertFalse(speech_review.impossible_word_rate("是的", .2))
        with TemporaryDirectory() as root:
            work = Path(root)
            sf.write(work/"mix.wav", np.full(12*16000, .05), 16000)
            sf.write(work/"voice.flac", np.full(4000, .02), 16000)
            cue = dict(text="One two three four", language="en", languageProbability=.9, speaker=1,
                       start=5., end=5.25, clip="voice.flac", overlapping=True)
            model = Mock()
            model.transcribe.side_effect = [self.words(.02, .2, " Stop"),
                                            self.words(3.53, 3.72), self.words(5.03, 5.19)]
            with patch.object(speech_review, "whisper_model", return_value=model):
                verified, _ = speech_review.review_transcript([cue], work, work)
            self.assertEqual(verified, [])

    def test_impossible_overlapping_turn_keeps_a_second_voice_but_drops_a_leaked_copy(self):
        with TemporaryDirectory() as root:
            work = Path(root)
            t = np.arange(16000)/16000
            speaker = (.2*np.sin(2*np.pi*180*t)).astype("float32")
            sf.write(work/"other.wav", speaker, 16000, subtype="FLOAT")
            other = dict(text="A real line", language="en", languageProbability=.99, speaker=1,
                         start=3., end=4., clip="other.wav")
            cue = dict(text="Too many guessed words", language="en", speaker=2,
                       start=3.25, end=3.5, overlapping=True)
            leak = .7*speaker[4000:8000]
            independent = (.03*np.sin(2*np.pi*290*t[:4000])).astype("float32")
            get_classifier = lambda: lambda samples: (.8, 0., 0.)
            with patch.object(speech_review, "speech_spans", return_value=[]):
                self.assertTrue(speech_review.duplicate_overlap(cue, leak, [other], work, get_classifier))
                self.assertFalse(speech_review.duplicate_overlap(cue, leak+independent, [other], work, get_classifier))
                self.assertFalse(speech_review.duplicate_overlap(cue, leak, [], work, get_classifier))

    def test_corrected_overlap_keeps_the_separated_speakers_clip_and_language(self):
        with TemporaryDirectory() as root:
            work = Path(root)
            sf.write(work/"mix.wav", np.full(12*16000, .05), 16000)
            isolated = np.linspace(-.2, .2, 4000, dtype="float32")
            sf.write(work/"voice.flac", isolated, 16000)
            cue = dict(text="One two three four", language="fr", languageProbability=.5, speaker=3,
                       start=5., end=5.25, clip="voice.flac", overlapping=True)
            model = Mock()
            model.transcribe.side_effect = [self.words(.02, .2), self.words(3.53, 3.72)]
            with patch.object(speech_review, "whisper_model", return_value=model), patch("dialogue.speaker_references"):
                verified, _ = speech_review.review_transcript([cue], work, work)
            self.assertEqual((verified[0]["speaker"], verified[0]["language"], verified[0]["text"]), (3, "en", "Wait"))
            saved, rate = sf.read(work/verified[0]["clip"])
            self.assertEqual(rate, 16000)
            self.assertGreater(np.corrcoef(saved, isolated)[0, 1], .999)

    def test_one_cut_of_the_same_recording_cannot_corroborate_itself(self):
        with TemporaryDirectory() as root:
            work = Path(root)
            samples = np.sin(2*np.pi*np.arange(6400)*200/16000)*.1
            sf.write(work/"mix.wav", samples, 16000)
            sf.write(work/"same-stem.wav", samples, 16000)
            sf.write(work/"voice.flac", np.zeros(6400), 16000)
            cue = dict(text="Guess", language="en", languageProbability=.35, speaker=2,
                       start=0., end=.4, clip="voice.flac")
            model = Mock()
            model.transcribe.return_value = self.words(.05, .29)
            with patch.object(speech_review, "whisper_model", return_value=model), \
                 patch.object(speech_review, "speech_spans", return_value=[(500, 5500)]):
                reviewed, _ = speech_review.review_transcript([cue], work, work, dialogue=work/"same-stem.wav")
            self.assertEqual(reviewed, [dict(cue, text="", preserveOriginal="unverified-source")])
            self.assertEqual(model.transcribe.call_count, 1)

    def test_review_uses_the_supplied_diarization_stem_and_keys_the_cache_by_its_version(self):
        with TemporaryDirectory() as root:
            work = Path(root)
            sf.write(work/"mix.wav", np.full(12*16000, .03), 16000)
            sf.write(work/"new-stem.wav", np.full(12*16000, .04), 16000)
            sf.write(work/"faint.flac", np.zeros(6400), 16000)
            cue = dict(text="Guess", language="en", languageProbability=.35, speaker=2,
                       start=5., end=5.4, clip="faint.flac")
            first = self.words(3.54, 3.82)
            empty = ([], first[1])
            model = Mock()
            model.transcribe.side_effect = [first, empty, empty, first, empty, empty]
            with patch.object(speech_review, "whisper_model", return_value=model), patch("dialogue.speaker_references"):
                restored, stage = speech_review.review_transcript([cue], work, work, dialogue=work/"new-stem.wav")
                previous, previous_stage = speech_review.review_transcript([cue], work, work)
            self.assertNotEqual(stage, previous_stage)
            self.assertEqual(restored[0]["text"], "Wait")
            self.assertEqual(previous, [])

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
                model.generate.side_effect = [[np.zeros(0)], [wave], [wave], [wave]]
                cue = dict(text="Hello", start=0., end=.75, language="en", speaker=2)
                with patch.dict(sys.modules, {"omnivoice": Mock(), "faster_whisper": Mock()}), \
                     patch.object(voices, "model_directory", return_value="whisper"), \
                     patch.object(voices, "load_voice_model", return_value=model), patch.object(voices, "model_path"), \
                     patch("voice_samples.align_clone_reference", return_value=(wave, "Aligned")), \
                     patch("voice_trim.trim_verified_take", return_value=None), \
                     patch.object(voices, "verifies_words", side_effect=[False, successful, False]):
                    voices.synthesize([cue], ["Bonjour"], "fr", work, out, [0], "cpu")
                self.assertEqual((out/"0.original").is_file(), not successful)
                self.assertEqual((out/"0.wav").is_file(), successful)
                self.assertFalse((out/"0.partial.wav").exists())
                self.assertEqual([c.kwargs["voice_clone_prompt"] for c in model.generate.call_args_list],
                                 [prompt, fixed, fixed] if successful else [prompt, fixed, fixed, fixed])
                self.assertTrue(all(c.kwargs["text"] == "Bonjour" for c in model.generate.call_args_list))

    def test_every_take_requires_its_target_words_including_short_and_unspaced_phrases(self):
        french = "Bonsoir les amis !"
        chinese = "我今天要去图书馆"
        cases = [
            ("fr", french, .64, ["Tout est fini", french], 2),
            ("fr", french, .64, [french], 1),
            ("zh", chinese, .64, ["再见", chinese], 2),
            ("fr", french, 1.2, [french], 1),
            ("fr", french, 1.2, ["Tout est fini", french], 2),
            ("fr", "Oui !", .64, ["Oui"], 1),
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
                     patch.object(voices, "model_directory", return_value="whisper"), \
                     patch.object(voices, "model_path"), patch.object(voices, "load_voice_model", return_value=model), \
                     patch("voice_trim.trim_verified_take", return_value=None), \
                     patch.object(voice_samples, "align_clone_reference", return_value=None):
                    voices.synthesize([cue], [target], language, work, out, [0], "cpu")
                self.assertEqual(model.generate.call_count, takes)
                self.assertEqual(transcribe.call_count, len(heard))
                self.assertEqual(whisper.WhisperModel.call_count, int(bool(heard)))
                self.assertEqual(sf.info(out/"0.wav").frames, round((first_duration if takes == 1 else 1.6)*rate))

    def test_an_intelligible_take_in_the_other_original_speakers_voice_is_rejected(self):
        first, second = np.array([1., 0.]), np.array([0., 1.])
        anchors = {0: first, 1: second}
        self.assertTrue(voices.wrong_speaker(second, 0, anchors))
        self.assertFalse(voices.wrong_speaker(first, 0, anchors))
        self.assertFalse(voices.wrong_speaker(np.array([.69, .71]), 0, anchors))


if __name__ == "__main__":
    unittest.main()
