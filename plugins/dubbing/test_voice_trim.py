import importlib.util
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch


RUNTIME = all(importlib.util.find_spec(name) for name in ("torch", "numpy", "scipy", "soundfile"))
if RUNTIME:
    import numpy as np
    from voice_trim import trim_verified_take


@unittest.skipUnless(RUNTIME, "requires the optional dubbing environment")
class VoiceTrimTests(unittest.TestCase):
    rate = 16000

    def clip(self, labels):
        wave = np.zeros(2*self.rate, np.float32)
        rows = []
        for i, label in enumerate(labels):
            start = .12+.37*i
            end = start+.23
            a, b = round(start*self.rate), round(end*self.rate)
            t = np.arange(b-a)/self.rate
            wave[a:b] = .24*np.sin(2*np.pi*(210+20*i)*t)
            rows.append(SimpleNamespace(word=label, start=start, end=end, probability=.92))
        segment = SimpleNamespace(words=rows, text=" ".join(labels), avg_logprob=-.2, no_speech_prob=.02)
        model = Mock()
        model.transcribe.return_value = ([segment], object())
        return wave, model

    def test_removes_only_separated_outer_words_and_rechecks_the_trimmed_take(self):
        wave, model = self.clip(["Yes", "Allez", "vite", "thanks"])
        with patch("voices.verifies_words", return_value=True) as verify:
            result = trim_verified_take(model, wave, self.rate, "fr", "Allez vite !")
        self.assertIsNotNone(result)
        self.assertLess(len(result), len(wave))
        verify.assert_called_once_with(model, result, self.rate, "fr", "Allez vite !")
        ideal = wave[round(.49*self.rate):round(1.09*self.rate)]
        # All samples of both intended words and their original pause remain.
        self.assertIn(ideal.tobytes(), result.tobytes())
        with patch("voices.verifies_words", return_value=False):
            self.assertIsNone(trim_verified_take(model, wave, self.rate, "fr", "Allez vite !"))

    def test_requires_all_requested_words_and_unambiguous_outer_boundaries(self):
        for labels in (["oui", "non", "oui", "oui"], ["oui", "oui", "oui", "oui"], ["oui", "oui"]):
            with self.subTest(labels=labels):
                wave, model = self.clip(labels)
                with patch("voices.verifies_words") as recheck:
                    self.assertIsNone(trim_verified_take(model, wave, self.rate, "fr", "Oui, oui, oui !"))
                recheck.assert_not_called()

    def test_rejects_low_confidence_and_masks_without_a_quiet_acoustic_gap(self):
        wave, model = self.clip(["Well", "hello"])
        # Physically continuous speech conflicts with the recognizer's word gap.
        continuous = np.sin(2*np.pi*220*np.arange(len(wave))/self.rate).astype("float32")
        with patch("voices.verifies_words") as recheck:
            self.assertIsNone(trim_verified_take(model, continuous, self.rate, "en", "Hello"))
            model.transcribe.return_value[0][0].words[1].probability = .45
            self.assertIsNone(trim_verified_take(model, wave, self.rate, "en", "Hello"))
        recheck.assert_not_called()

    def test_long_take_skips_recognition_and_cannot_cut_inside_one_acoustic_word(self):
        model = Mock()
        self.assertIsNone(trim_verified_take(model, np.ones(7*self.rate), self.rate, "en", "Hello"))
        model.transcribe.assert_not_called()
        wave, model = self.clip(["好了", "朋友"])
        with patch("voices.verifies_words") as recheck:
            self.assertIsNone(trim_verified_take(model, wave, self.rate, "zh", "了朋友"))
        recheck.assert_not_called()


if __name__ == "__main__":
    unittest.main()
