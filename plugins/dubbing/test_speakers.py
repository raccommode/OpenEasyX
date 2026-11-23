"""Speaker assignment and soundtrack regressions for the optional dubbing runtime."""
import importlib.util
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

RUNTIME = all(importlib.util.find_spec(name) for name in ("torch", "numpy", "scipy", "soundfile"))
if RUNTIME:
    import numpy as np
    import soundfile as sf
    import dialogue
    import voices


@unittest.skipUnless(RUNTIME, "requires the optional dubbing Python environment")
class SpeakerTests(unittest.TestCase):
    def test_natural_delivery_only_uses_free_time_between_lines(self):
        cues = [dict(start=0., end=1.), dict(start=3., end=5.), dict(start=4., end=6.),
                dict(start=6.2, end=7.)]
        np.testing.assert_allclose(voices.delivery_durations(cues, 7.5), [2.25, 2., 2., 1.22])

    def test_metal_workers_resume_only_pending_translated_phrases_in_bounded_groups(self):
        cues = [{"language": "en"} for _ in range(10)]
        cues[2]["language"] = "fr"
        with tempfile.TemporaryDirectory() as tmp, patch.object(voices, "device", return_value="mps"), patch.object(voices.subprocess, "run") as run:
            work = Path(tmp)
            (work/"0.wav").touch()
            run.return_value.returncode = 0
            voices.speak(cues, [], "fr", work, work)
            self.assertEqual([call.args[0][5:] for call in run.call_args_list], [
                ["1", "3", "4", "5", "6", "7"], ["8", "9"],
            ])

    def test_only_uncertain_short_language_changes_fall_back_to_the_same_speakers_language(self):
        cues = [
            dict(start=0, end=8, speaker=0, language="en", languageProbability=.92),
            dict(start=9, end=10, speaker=0, language="ru", languageProbability=.14, clip="short.flac"),
            dict(start=11, end=12, speaker=0, language="fr", languageProbability=.88, clip="short.flac"),
            dict(start=13, end=14, speaker=1, language="de", languageProbability=.20),
        ]
        whisper = Mock()
        whisper.detect_language.side_effect = [("en", .97, []), ("fr", .88, [])]
        whisper.transcribe.return_value = ([SimpleNamespace(text="Hello", avg_logprob=-.3, no_speech_prob=.01)], None)
        with tempfile.TemporaryDirectory() as tmp:
            sf.write(Path(tmp)/"short.flac", np.zeros(16000), 16000)
            dialogue.resolve_short_languages(cues, Path(tmp), whisper)
        self.assertEqual([cue["language"] for cue in cues], ["en", "en", "fr", "de"])
        whisper.transcribe.assert_called_once()

    def test_recurring_speaker_can_merge_but_simultaneous_voices_never_merge(self):
        turns = [(0, 60, 0), (30, 90, 1), (100, 150, 2), (160, 210, 3)]
        vectors = {0: np.array([1., 0.]), 1: np.array([.8, .6]),
                   2: np.array([.8, .6]), 3: np.array([0., -1.])}
        aliases = dialogue.speaker_aliases(list(dialogue.spans(turns)), turns, vectors)
        self.assertEqual(aliases[1], aliases[2])
        self.assertNotEqual(aliases[0], aliases[1])
        self.assertNotIn(aliases[3], {aliases[0], aliases[1]})

    def test_panned_overlap_recovers_the_voice_missing_from_the_dialogue_stem(self):
        length = 16000
        t = np.arange(3*length, dtype=np.float32) / length
        a = (.2*np.sin(2*np.pi*210*t)).astype(np.float32)
        b = (.14*np.sin(2*np.pi*330*t)).astype(np.float32)
        a[2*length:] = 0
        b[:length] = 0
        original = a[:, None]*[1.3, .7] + b[:, None]*[.7, 1.3]
        stem = a.copy()
        stem[2*length:] = b[2*length:]
        turns = [(0, 2*length, 0), (length, 3*length, 1)]
        with patch.object(dialogue, "embedding", side_effect=[np.eye(2)[0], np.eye(2)[1]]), \
             patch.object(dialogue, "separate_overlap", side_effect=AssertionError("unexpected mono fallback")):
            out = dialogue.speaker_audio(stem, original, turns, None, {}, {})
        self.assertEqual([item[1] for item in out], [0, 1])
        np.testing.assert_allclose(out[0][2], a[:2*length], atol=1e-5)
        np.testing.assert_allclose(out[1][2], b[length:], atol=1e-5)

    def test_centered_voices_use_the_original_mix_for_neural_separation(self):
        sample = np.ones(48000, dtype=np.float32) * .1
        original = np.repeat(sample[:, None], 2, axis=1)
        original[16000:32000] += .25
        refs = [np.eye(2)[0], np.eye(2)[1]]
        with patch.object(dialogue, "embedding", side_effect=refs*2), \
             patch.object(dialogue, "separate_overlap", side_effect=lambda audio, *_: [audio, audio]) as sep:
            dialogue.speaker_audio(sample, original, [(0, 32000, 0), (16000, 48000, 1)], None, {}, {})
        audio = sep.call_args.args[0]
        self.assertAlmostEqual(float(audio.max()), .35, places=5)

    def test_quiet_camera_voice_is_removed_and_translation_has_programme_loudness(self):
        rate = 44100
        with tempfile.TemporaryDirectory() as tmp:
            work = Path(tmp)
            t = np.arange(4*rate) / rate
            active = (t >= .5) & (t < 3.)
            original = (.10*np.sin(2*np.pi*440*t)*active)[:, None] * [1.25, .75]
            music = (.008*np.sin(2*np.pi*155*t))[:, None] * [.8, 1.2]
            sf.write(work/"mix.wav", original + music, rate, subtype="FLOAT")
            sf.write(work/"dialogue.wav", .02*original, rate, subtype="FLOAT")
            # Two adjacent lines have an intentional level difference.
            cues = [{"start": .5, "end": 1.5, "direction": [1.25, .75], "speaker": 0},
                    {"start": 1.5, "end": 3., "direction": [1.25, .75], "speaker": 0}]
            for idx, cue in enumerate(cues):
                wave = .004*np.sin(2*np.pi*1050*np.arange(round((cue["end"]-cue["start"])*rate))/rate)
                sf.write(work/f"{idx}.wav", wave, rate, subtype="FLOAT")
            with patch("enhance.speech_enhancer"), patch("enhance.enhance_speech", return_value=original) as repair:
                voices.mix_voices(work/"mix.wav", work/"dialogue.wav", cues, work, work, work/"out.wav")
            repair.assert_called_once()
            out = sf.read(work/"out.wav")[0]
            gap = (t < .45) | (t > 3.05)
            np.testing.assert_allclose(out[gap], music[gap], atol=2e-7)
            inner = (t > .55) & (t < 2.95)
            remaining = np.sum(original[inner]*(out[inner]-music[inner]))/np.sum(original[inner]**2)
            self.assertLess(abs(remaining), .02)
            self.assertAlmostEqual(voices.dialogue_loudness(work/"out.wav"), -18., delta=1.)
            self.assertLess(float(np.abs(out).max()), .94)

    def test_translation_tail_plays_over_the_original_gap_without_subtracting_it(self):
        rate = 44100
        with tempfile.TemporaryDirectory() as tmp:
            work = Path(tmp)
            t = np.arange(rate*3)/rate
            bg = (.04*np.cos(2*np.pi*130*t))[:, None]
            original = (.1*np.sin(2*np.pi*350*t)*((t>=.25)&(t<.9)))[:, None]
            sf.write(work/"mix.wav", bg+original, rate, subtype="FLOAT")
            # A film model might classify part of the ambient sound as speech.
            # Its estimate outside the original line must be completely ignored.
            sf.write(work/"dialogue.wav", original + bg*(t>.9)[:, None], rate, subtype="FLOAT")
            tail = .02*np.sin(2*np.pi*870*np.arange(round(1.35*rate))/rate)
            sf.write(work/"0.wav", tail, rate, subtype="FLOAT")
            cues = [dict(start=.25, end=.9, speaker=0, direction=[1.])]
            voices.render_voice_buses(work/"mix.wav", work/"dialogue.wav", cues, work, work,
                                      work/"bed.wav", work/"dry.wav", iter([]), {})
            bed = sf.read(work/"bed.wav")[0]
            dry = sf.read(work/"dry.wav")[0]
            gap = (t>1.01)&(t<1.55)
            np.testing.assert_allclose(bed[gap], bg[gap, 0], atol=1e-7)
            np.testing.assert_allclose(dry[gap], tail[np.where(gap)[0]-round(.25*rate)], atol=1e-7)
            np.testing.assert_array_equal(dry[t>1.62], 0.)

    def test_overlapping_tones_regain_their_independent_pans(self):
        rate = 44100
        t = np.arange(rate) / rate
        signals = np.stack([np.sin(2*np.pi*f*t) for f in (340, 1510, 2600)], axis=1) * .1
        pans = [[1.3, .7], [.8, 1.2]]
        original = np.einsum("ts,sc->tc", signals, np.array(pans + [[.6, 1.4]]))
        centered = np.repeat(signals[:, :2].sum(axis=1, keepdims=True), 2, axis=1)
        speech = voices.position_overlap(original, centered, pans)
        remaining = np.linalg.lstsq(signals, original-speech, rcond=None)[0]
        np.testing.assert_allclose(remaining[:2], 0, atol=.025)
        np.testing.assert_allclose(remaining[2], [.6, 1.4], atol=.025)

    def test_remix_removes_panned_solo_and_quiet_overlap_and_preserves_background(self):
        with tempfile.TemporaryDirectory() as tmp:
            work = Path(tmp)
            rate = 44100
            frames = np.arange(3 * rate)
            a = .2 * np.sin(2*np.pi*250*frames/rate)
            b = .1 * np.sin(2*np.pi*440*frames/rate)
            a[(frames < rate//2) | (frames >= 2*rate)] = 0
            b[(frames < rate) | (frames >= 2.5*rate)] = 0
            background = (.03*np.cos(2*np.pi*110*frames/rate))[:, None] * [1.2, .8]
            pan_a, pan_b = [1.2, .8], [.7, 1.3]
            mix = background + a[:, None]*pan_a + b[:, None]*pan_b
            # The cinematic model centers solo speech and misses B in the overlap.
            vocal = a[:, None] * np.where((frames < rate)[:, None], [1., 1.], pan_a)
            sf.write(work/"mix.wav", mix, rate, subtype="FLOAT")
            sf.write(work/"dialogue.wav", vocal, rate, subtype="FLOAT")
            for idx, duration in enumerate((1.5, 1.5)):
                sf.write(work/f"{idx}.wav", np.zeros(round(duration*rate)), rate, subtype="FLOAT")
            cues = [{"start": .5, "end": 2., "speaker": 0, "direction": pan_a},
                    {"start": 1., "end": 2.5, "speaker": 1, "direction": pan_b}]
            with patch.object(dialogue, "cinematic_separator"), \
                 patch.object(dialogue, "isolate_dialogue", return_value=b[:, None]*pan_b) as second_pass:
                for _ in range(2):
                    voices.mix_voices(work/"mix.wav", work/"dialogue.wav", cues, work, work, work/"out.wav")
            self.assertEqual(second_pass.call_count, 2)  # overlap and B’s suppressed solo flank
            out = sf.read(work/"out.wav")[0]
            away_from_fades = np.ones(len(frames), dtype=bool)
            for t in (.5, 1., 2., 2.5):
                away_from_fades &= abs(frames-t*rate) > rate*.012
            np.testing.assert_allclose(out[away_from_fades], background[away_from_fades], atol=1e-6)
