"""Speaker assignment and soundtrack regressions for the optional dubbing runtime."""
import importlib.util
import shutil
import sys
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
    def test_cinematic_stem_has_its_own_cache_and_reconstructs_overlapped_blocks_on_the_source_clock(self):
        with tempfile.TemporaryDirectory() as tmp:
            work = Path(tmp)
            rate = 44100
            t = np.arange(14*rate+77)/rate
            samples = (.25*np.sin(2*np.pi*440*t))[:, None]*[1., -.6]
            source = work/"source.wav"
            sf.write(source, samples, rate, subtype="FLOAT")
            sf.write(work/"dialogue.wav", np.zeros_like(samples), rate)
            sf.write(work/"mix.wav", np.zeros_like(samples), rate)
            with patch.object(dialogue, "ffmpeg", side_effect=lambda *args: shutil.copyfile(source, args[-1])), \
                 patch.object(dialogue, "cinematic_separator") as load, \
                 patch.object(dialogue, "isolate_dialogue", side_effect=lambda _model, audio: audio*.5) as separate:
                mix, stem = dialogue.separate_dialogue(source, work)
                self.assertEqual(dialogue.separate_dialogue(source, work), (mix, stem))
            self.assertNotEqual(stem, work/"dialogue.wav")
            self.assertFalse(stem.with_suffix(".partial.wav").exists())
            np.testing.assert_allclose(sf.read(stem)[0], samples*.5, atol=3e-8)
            self.assertEqual(load.call_count, 1)
            self.assertEqual(separate.call_count, 3)
    def test_small_cuda_budget_or_a_real_allocation_failure_moves_only_the_voice_backbone(self):
        for tight in (True, False):
            model_class, backbone, codec = Mock(), Mock(), object()
            backbone.audio_tokenizer = codec
            backbone.to.side_effect = lambda device: self.assertIsNone(backbone.audio_tokenizer)
            model_class.from_pretrained.side_effect = [backbone] if tight else [
                voices.torch.cuda.OutOfMemoryError("busy GPU"), backbone]
            with self.subTest(tight=tight), patch.object(voices, "progress"), \
                 patch.object(voices.torch.cuda, "mem_get_info", return_value=((2 if tight else 8)*1024**3, 12*1024**3)), \
                 patch.object(voices.torch.cuda, "empty_cache") as empty:
                model = voices.load_voice_model(model_class, "voice", "cuda", voices.torch.bfloat16, 38)
            self.assertIs(model, backbone)
            self.assertIs(model.audio_tokenizer, codec)
            backbone.to.assert_called_once_with("cuda")
            calls = model_class.from_pretrained.call_args_list
            self.assertEqual([c.kwargs["device_map"] for c in calls], ["cpu"] if tight else ["cuda", "cpu"])
            self.assertEqual(calls[-1].kwargs["dtype"], voices.torch.bfloat16)
            self.assertEqual(empty.call_count, 0 if tight else 1)

    def test_other_devices_and_cuda_with_headroom_keep_the_normal_voice_model(self):
        for device in ("cuda", "mps", "cpu"):
            model_class = Mock()
            with self.subTest(device=device), patch.object(voices.torch.cuda, "mem_get_info", return_value=(4*1024**3, 12*1024**3)) as mem:
                model = voices.load_voice_model(model_class, "voice", device, voices.torch.bfloat16, 38)
            self.assertIs(model, model_class.from_pretrained.return_value)
            model_class.from_pretrained.assert_called_once_with("voice", device_map=device, dtype=voices.torch.bfloat16)
            self.assertEqual(mem.call_count, int(device == "cuda"))

    def test_translation_moves_tied_half_precision_weights_to_cuda(self):
        scenarios = [("cuda", True, voices.torch.bfloat16), ("cuda", False, voices.torch.float16),
                     ("cpu", False, None), ("mps", False, None)]
        for accelerator, has_bf16, dtype in scenarios:
            factory = Mock()
            before = voices.torch.__future__.get_swap_module_params_on_conversion()
            def move(destination):
                self.assertEqual(destination, accelerator)
                self.assertEqual(voices.torch.__future__.get_swap_module_params_on_conversion(), True if dtype else before)
                return factory.from_pretrained.return_value
            factory.from_pretrained.return_value.eval.return_value.to.side_effect = move
            with self.subTest(accelerator=accelerator, dtype=dtype), \
                 patch.object(voices.torch.cuda, "is_bf16_supported", return_value=has_bf16) as supported:
                voices.load_translation_model(factory, "checkpoint", accelerator)
            self.assertEqual(voices.torch.__future__.get_swap_module_params_on_conversion(), before)
            if dtype:
                supported.assert_called_once_with(including_emulation=False)
                factory.from_pretrained.assert_called_once_with("checkpoint", dtype=dtype)
            else:
                supported.assert_not_called()
                factory.from_pretrained.assert_called_once_with("checkpoint")

    def test_cuda_oom_during_load_or_generation_retries_on_cpu_without_repeating_completed_batches(self):
        for on_load in (True, False):
            transformers, gpu, cpu = Mock(), Mock(), Mock()
            load_cpu = transformers.AutoModelForSeq2SeqLM.from_pretrained
            load_cpu.return_value.eval.return_value.to.return_value = cpu
            oom = voices.torch.cuda.OutOfMemoryError("busy")
            cues = [{"language": "en", "text": str(i)} for i in range(10)]
            completed = []
            def batch(model, tokenizer, lines, target, device):
                if model is gpu and lines[0] == "8":
                    raise oom
                if device == "cpu":
                    self.assertIs(model, cpu)
                    self.assertEqual(len(lines), 1)
                completed.extend(lines)
                return ["fr "+text for text in lines]
            with self.subTest(on_load=on_load), tempfile.TemporaryDirectory() as folder, \
                 patch.dict(sys.modules, {"transformers": transformers}), patch.object(voices, "device", return_value="cuda"), \
                 patch.object(voices, "model_path", return_value="checkpoint"), patch.object(voices, "progress"), \
                 patch.object(voices, "load_translation_model", side_effect=[oom if on_load else gpu]), \
                 patch.object(voices, "translate_batch", side_effect=batch), patch.object(voices.torch.cuda, "empty_cache") as empty:
                cache = Path(folder)/"translations.json"
                self.assertEqual(voices.translate(cues, "fr", cache), ["fr "+str(i) for i in range(10)])
                self.assertTrue(cache.is_file())
            self.assertEqual(completed, [str(i) for i in range(10)])
            empty.assert_called_once()
            load_cpu.assert_called_once_with("checkpoint")
            load_cpu.return_value.eval.return_value.to.assert_called_once_with(dtype=voices.torch.bfloat16)

    def test_natural_delivery_only_uses_free_time_between_lines(self):
        cues = [dict(start=0., end=1.), dict(start=3., end=5.), dict(start=4., end=6.),
                dict(start=6.2, end=7.)]
        np.testing.assert_allclose(voices.delivery_durations(cues, 7.5), [2.25, 2., 2., 1.22])

    def test_metal_workers_resume_only_pending_translated_phrases_in_bounded_groups(self):
        cues = [{"language": "en"} for _ in range(10)]
        cues[2]["language"] = "fr"
        with tempfile.TemporaryDirectory() as tmp, patch.object(voices, "device", return_value="mps"), patch.object(voices.subprocess, "run") as run:
            work = Path(tmp)
            sf.write(work/"0.wav", np.ones(2400, dtype="float32")*.1, 24000)
            (work/"1.wav").touch()
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

    def test_source_speech_outside_the_transcript_is_removed_while_translation_plays_across_the_gap(self):
        rate = 44100
        with tempfile.TemporaryDirectory() as tmp:
            work = Path(tmp)
            t = np.arange(rate*3)/rate
            bg = (.04*np.cos(2*np.pi*130*t))[:, None]
            original = (.1*np.sin(2*np.pi*350*t)*(((t>=.2)&(t<1.2)) | ((t>=2)&(t<2.5))))[:, None]
            sf.write(work/"mix.wav", bg+original, rate, subtype="FLOAT")
            # Source dialogue starts early, ends late, and an entire line was missed by ASR.
            sf.write(work/"dialogue.wav", original, rate, subtype="FLOAT")
            tail = .02*np.sin(2*np.pi*870*np.arange(round(1.35*rate))/rate)
            sf.write(work/"0.wav", tail, rate, subtype="FLOAT")
            cues = [dict(start=.25, end=.9, speaker=0, direction=[1.])]
            voices.render_voice_buses(work/"mix.wav", work/"dialogue.wav", cues, work, work,
                                      work/"bed.wav", work/"dry.wav", iter([]), {})
            bed = sf.read(work/"bed.wav")[0]
            dry = sf.read(work/"dry.wav")[0]
            gap = (t>1.01)&(t<1.55)
            np.testing.assert_allclose(bed, bg[:, 0], atol=1e-7)
            np.testing.assert_allclose(dry[gap], tail[np.where(gap)[0]-round(.25*rate)], atol=1e-7)
            np.testing.assert_array_equal(dry[t>1.62], 0.)

    def test_only_the_target_language_speaker_is_restored_during_overlap(self):
        rate = 44100
        with tempfile.TemporaryDirectory() as tmp:
            work = Path(tmp)
            t = np.arange(rate)/rate
            a = .1*np.sin(2*np.pi*220*t)
            b = .1*np.sin(2*np.pi*580*t)
            pan_a, pan_b = [1.4, .6], [.5, 1.5]
            speech = a[:, None]*pan_a + b[:, None]*pan_b
            bg = (.03*np.sin(2*np.pi*112*t))[:, None]*[1., -1.]
            for name, samples in (("mix.wav", bg+speech), ("dialogue.wav", speech),
                                  ("native.wav", a), ("1.wav", np.zeros(rate))):
                sf.write(work/name, samples, rate, subtype="FLOAT")
            cues = [dict(start=0., end=1., speaker=0, language="fr", direction=pan_a, clip="native.wav"),
                    dict(start=0., end=1., speaker=1, language="en", direction=pan_b)]
            def render():
                voices.render_voice_buses(work/"mix.wav", work/"dialogue.wav", cues, work, work,
                                          work/"bed.wav", work/"dry.wav", iter([]), {}, language="fr")
            render()
            bed = sf.read(work/"bed.wav")[0]
            inner = slice(600, -600)
            np.testing.assert_allclose(bed[inner], (bg+a[:, None]*pan_a)[inner], atol=1e-6)
            (work/"1.wav").unlink()
            with self.assertRaisesRegex(ValueError, "Missing translated voice"):
                render()

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
