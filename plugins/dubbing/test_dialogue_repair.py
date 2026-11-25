"""Regression tests for restoring source dialogue ahead of speaker assignment."""
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

AVAILABLE = all(importlib.util.find_spec(x) for x in ("numpy", "scipy", "soundfile", "torch"))
if AVAILABLE:
    import numpy as np
    import soundfile as sf
    import dialogue
    import dialogue_repair as repair


@unittest.skipUnless(AVAILABLE, "requires the optional dubbing environment")
class DialogueRepairTests(unittest.TestCase):
    def test_short_overlapping_vad_views_find_speech_missed_by_the_long_recurrent_context(self):
        rate = 16000
        signal = np.arange(32*rate, dtype="float32")/rate
        def detect(view):
            if len(view) == 12*rate and view[0] == 6.:
                return [(6.1, 7.3)]
            return []
        with patch.object(repair, "vad_ranges", side_effect=detect):
            self.assertEqual(repair.source_ranges(signal), [(12.1, 13.3)])

    def test_dominant_music_in_one_channel_does_not_mask_a_quiet_missed_word_in_another(self):
        rate = 16000
        t = np.arange(4*rate)/rate
        original = np.stack((.6*np.sin(2*np.pi*330*t), .035*np.sin(2*np.pi*210*t)), axis=1).astype("float32")
        def score(audio):
            return (0., .91, .84) if np.max(np.abs(audio)) > .3 else (.75, .001, .001)
        with patch.object(repair, "vad_ranges", return_value=[(1., 1.3), (1.75, 2.25)]), \
             patch.object(repair, "lexical_times", return_value=[repair.Word("Hello", "en", 1.9, 2.2, .9)]) as decode, \
             patch("enhance.enhance_speech", side_effect=lambda model, signal, sr: signal*.8):
            result = repair.repair_block(original, np.zeros_like(original), rate, lambda: score, Mock(), Mock())
        np.testing.assert_array_equal(result[:, 0], 0)
        np.testing.assert_array_equal(result[:rate//3, 1], 0)
        np.testing.assert_allclose(result[rate:2*rate, 1], .84*original[rate:2*rate, 1], atol=2e-8)
        self.assertEqual(decode.call_count, 2)

    def test_music_hums_and_uncorroborated_noises_keep_their_native_background(self):
        rate = 16000
        mix = np.full((2*rate, 1), .3, np.float32)
        for scores, words in [((0., .91, .8), []), ((.41, .003, .002), []),
                              ((.4, .004, .005), [repair.Word("one", "en", .75, 1.2, .65)])]:
            recognizer, enhancer = Mock(), Mock()
            with patch.object(repair, "vad_ranges", return_value=[(.5, 1.5)]), \
                 patch.object(repair, "lexical_times", side_effect=[words, []]), \
                 patch.object(repair, "rescue_words", return_value=[]), \
                 patch("enhance.enhance_speech", enhancer):
                result = repair.repair_block(mix, np.zeros_like(mix), rate, lambda: lambda audio: scores,
                                             Mock(), recognizer)
            np.testing.assert_array_equal(result, 0.)
            enhancer.assert_not_called()

    def test_a_real_word_does_not_remove_later_untranscribed_vocalizations_in_the_same_group(self):
        rate = 16000
        sound = np.full((6*rate, 1), .12, np.float32)
        activity = [(.5, 1.3), (1.7, 2.2), (2.7, 3.3), (3.6, 4.4)]
        with patch.object(repair, "vad_ranges", return_value=activity), \
             patch.object(repair, "lexical_times", return_value=[repair.Word("word", "en", .7, 1.1, .95)]), \
             patch("enhance.enhance_speech", side_effect=lambda _, signal, __: signal*.9):
            result = repair.repair_block(sound, np.zeros_like(sound), rate,
                                         lambda: lambda _: (.8, 0., 0.), Mock(), Mock())
        self.assertGreater(result[rate, 0], .09)
        np.testing.assert_array_equal(result[2*rate:, 0], 0.)

    def test_captured_overlapping_speakers_keep_original_stem_and_antiphase_mono_keeps_its_polarity(self):
        rate = 16000
        t = np.arange(2*rate)/rate
        speech = (.2*np.sin(2*np.pi*210*t)).astype("float32")
        stereo = np.column_stack((speech, -speech))
        with patch.object(repair, "vad_ranges", return_value=[(.2, 1.7)]):
            available = repair.repair_block(stereo, stereo.copy()*.9, rate, Mock(side_effect=AssertionError),
                                            Mock(side_effect=AssertionError), Mock(side_effect=AssertionError))
        np.testing.assert_array_equal(available, stereo*.9)
        with patch.object(repair, "repair_channel", side_effect=lambda x, v, *args: v.__setitem__(slice(None), x*.71)) as single:
            restored = repair.repair_block(stereo, np.zeros_like(stereo), rate, Mock(), Mock(), Mock())
        self.assertEqual(single.call_count, 1)
        np.testing.assert_array_equal(restored[:, 1], -restored[:, 0])

    def test_fresh_analysis_reuses_uncorrected_cinematic_file_then_publishes_independent_cache(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            mix, raw = root/"mix.wav", root/"dialogue-bandit-v2.wav"
            audio = np.linspace(0., .3, 8000, dtype="float32")
            sf.write(mix, audio, 16000, subtype="FLOAT")
            sf.write(raw, audio*.2, 16000, subtype="FLOAT")
            with patch.object(dialogue, "cinematic_separator", side_effect=AssertionError), \
                 patch.object(repair, "repair_block", side_effect=lambda x, v, *args: x*.7) as run:
                _, refined = dialogue.separate_dialogue(root/"source.mov", root)
                self.assertEqual(dialogue.separate_dialogue(root/"source.mov", root), (mix, refined))
            self.assertEqual(run.call_count, 1)
            self.assertNotEqual(refined, raw)
            self.assertEqual(json.loads(refined.with_suffix(".words.json").read_text()), [])
            np.testing.assert_array_equal(sf.read(raw, dtype="float32")[0], audio*.2)
            np.testing.assert_array_equal(sf.read(refined, dtype="float32")[0], audio*.7)

    def test_different_context_at_a_block_boundary_crossfades_the_repair_on_the_source_clock(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            rate = 1000
            base, mix, dst = [root/f"{name}.wav" for name in ("base", "mix", "repaired")]
            x = np.zeros((25*rate, 1), np.float32)
            for path in (mix, base):
                sf.write(path, x, rate, subtype="FLOAT")
            with patch.object(repair, "repair_block", side_effect=lambda block, *_: np.ones_like(block) if len(block) == len(x) else block):
                repair.repair_dialogue(mix, base, dst)
            out, _ = sf.read(dst, dtype="float32")
            self.assertEqual(len(out), len(x))
            self.assertLess(np.abs(np.diff(out)).max(), .014)
            self.assertEqual(out[24*rate-1], 1.)
            self.assertEqual(out[-1], 0.)

    def test_fixed_view_requires_matching_source_words_in_two_contexts(self):
        group = [(7.6, 7.9, (.8, .001, 0.)), (8.8, 9.2, (.94, 0., 0.))]
        def decode(start, leveled):
            token = "Oui" if start in (7., 8.) else "Non"
            return [repair.Word(token, "fr", 8.9-start, 9.1-start, .91)]
        words = repair.rescue_words(np.zeros(16*16000), group, decode, [])
        self.assertEqual(words, [repair.Word("Oui", "fr", 8.9, 9.1, .91)])
        one = repair.Word("Seul", "fr", 8.8, 9.1, .99)
        self.assertEqual(repair.confirmed_words([one], [], True), ([one], []))
        weak = repair.Word("Seul", "fr", 8.8, 9.1, .62)
        self.assertEqual(repair.confirmed_words([weak], [weak], True), ([], []))

    def test_landmarks_keep_original_spelling_clock_and_repeated_nonoverlapping_words(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            mix, base, dst = [root/f"{name}.wav" for name in ("mix", "base", "repaired")]
            audio = np.zeros(26*1000, np.float32)
            for path in (mix, base):
                sf.write(path, audio, 1000, subtype="FLOAT")
            def supply(block, _, rate, classifier, denoiser, recognizer, words):
                offset = 20 if len(block) < len(audio) else 0
                for start, end, prob in ((23.7, 23.94, .9), (23.71, 23.93, .94), (24.1, 24.35, .91)):
                    words.append(repair.Word("Très", "fr", start-offset, end-offset, prob))
                return block
            with patch.object(repair, "repair_block", side_effect=supply):
                repair.repair_dialogue(mix, base, dst)
            rows = json.loads(dst.with_suffix(".words.json").read_text())
            self.assertEqual([(w["text"], w["language"], w["start"], w["confidence"]) for w in rows],
                             [("Très", "fr", 23.71, .94), ("Très", "fr", 24.1, .91)])
            dst.with_suffix(".words.json").unlink()
            with patch.object(repair, "repair_block", side_effect=RuntimeError("interrupted")):
                with self.assertRaisesRegex(RuntimeError, "interrupted"):
                    repair.repair_dialogue(mix, base, dst)
            self.assertFalse(dst.with_suffix(".words.json").exists())


if __name__ == "__main__":
    unittest.main()
