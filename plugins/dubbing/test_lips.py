"""Dubbing runtime regressions. Tests never fetch model weights."""
import importlib.util
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

RUNTIME = all(importlib.util.find_spec(name) for name in (
    "av", "cv2", "numpy", "onnxruntime", "scipy", "soundfile", "librosa", "faster_whisper",
))
if RUNTIME:
    import av
    import numpy as np
    import soundfile as sf
    from scipy.signal import get_window, lfilter
    import lips


@unittest.skipUnless(RUNTIME, "requires the optional dubbing Python environment")
class LipSyncTests(unittest.TestCase):
    def setUp(self):
        scratch = tempfile.TemporaryDirectory(dir=os.environ.get("EASYX_DUBBING_TEST_DIR"))
        self.addCleanup(scratch.cleanup)
        self.tmp = Path(scratch.name)

    def test_overlapping_turns_use_original_wav_indices(self):
        turns = lips.Timeline([{"start": 2, "end": 5}, {"start": 1, "end": 3}])
        self.assertEqual(list(turns.at(1)), [1])
        self.assertEqual(set(turns.at(2)), {0, 1})
        self.assertEqual(list(turns.at(3)), [0])
        self.assertEqual(turns.at(5), {})

    def test_longer_dub_extends_animation_without_extending_identity_evidence(self):
        original = [{"start": 1., "end": 2., "speaker": 2}, {"start": 4., "end": 5., "speaker": 3}]
        path = self.tmp/"0.wav"
        sf.write(path, np.zeros(35200, "float32"), 16000)
        voice = lips.voice_timeline(original, {0: path})
        self.assertIn(0, voice.at(3.1))
        self.assertEqual(voice.at(3.2), {})
        self.assertEqual(original[0]["end"], 2.)

    @unittest.skipUnless(shutil.which("ffmpeg"), "requires ffmpeg")
    def test_selected_visible_speaker_rests_before_after_and_between_phonations(self):
        source, mix, out = self.tmp/"in.mp4", self.tmp/"mix.wav", self.tmp/"out.mp4"
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "color=s=128x64:r=25",
                        "-t", "2", "-c:v", "libx264", str(source)], check=True)
        rate = 16000
        wave = np.zeros(2*rate, "float32")
        wave[3200:7200] = .2
        wave[14400:19200] = .2
        sf.write(self.tmp/"0.wav", wave, rate)
        sf.write(self.tmp/"1.wav", np.full(6400, .2, "float32"), rate)
        sf.write(mix, wave, rate)
        cues = [{"start": 0., "end": 2., "speaker": 0}, {"start": .60, "end": 1.12, "speaker": 1}]
        seen, frame = {}, [-1]
        rows = np.float32([[4, 2, 40, 40], [72, 2, 40, 40]])
        vectors = np.eye(3, dtype="float32")
        crop = np.zeros((112, 112), "uint8")
        class Faces:
            def detect(self, _):
                frame[0] += 1
                # A lookalike with an unknown embedding occupies A's position
                # after a cut. B stays on screen.
                a = 2 if 15 <= frame[0] < 20 else 0
                return [(rows[0], vectors[a], crop), (rows[1], vectors[1], crop)]
        class Lips:
            def apply(self, image, row, audio, *, identity, t, amount):
                seen[frame[0], int(row[0])] = "speaking"
                return True
            def rest(self, image, row, identity, t):
                seen[frame[0], int(row[0])] = "resting"
                return True
        def learn(source, cues, faces, model, anchors):
            anchors[0, 0] = [(0.12, rows[0]), (.84, rows[0])]
            anchors[1, 1] = [(.72, rows[1])]
            return list(vectors[:2]), {0: 0, 1: 1}
        with patch.object(lips, "FaceModels", Faces), patch.object(lips, "LipModel", Lips), \
             patch.object(lips, "learn_speakers", learn), patch.object(lips, "progress"):
            lips.render(source, mix, cues, self.tmp, out)
        self.assertEqual(seen[0, 4], "resting")
        self.assertEqual(seen[7, 4], "speaking")
        self.assertEqual(seen[13, 4], "resting")
        self.assertNotIn((17, 4), seen)
        self.assertEqual(seen[17, 72], "speaking")
        self.assertEqual(seen[24, 4], "speaking")
        self.assertEqual(seen[26, 72], "resting")
        self.assertEqual(seen[42, 4], "resting")
        self.assertNotIn((42, 72), seen)

    def test_weak_pauses_are_distinct_from_quiet_speech(self):
        wave = np.full(32000, .000001, "float32")
        wave[3200:9600] = .003
        wave[12000:14000] = .00015
        wave[16000:22400] = .003
        path = self.tmp/"quiet.wav"
        sf.write(path, wave, 16000, subtype="FLOAT")
        gate = lips.PhraseActivity(path)
        self.assertTrue(gate.audible(.3))
        self.assertTrue(gate.audible(.8))
        self.assertFalse(gate.audible(.68))
        self.assertFalse(gate.audible(1.6))
        self.assertEqual(gate.articulation(.68), 0.)
        self.assertEqual(gate.articulation(.32), 1.)
        self.assertGreater(gate.articulation(.24), gate.articulation(.21))
        self.assertGreater(gate.articulation(.57), gate.articulation(.60))
        # A short isolated consonant can still reach full articulation.
        self.assertEqual(gate.articulation(.81), 1.)

    def test_face_matching_ignores_position_and_ambiguous_identities(self):
        vectors = list(np.eye(3, dtype="float32"))
        protos = vectors[:2]
        faces = [(None, vector, None) for vector in (vectors[1], vectors[2], vectors[0])]
        self.assertEqual(lips.identify(faces, protos), {0: 1, 2: 0})
        ambiguous = (vectors[0] + vectors[1]) / np.sqrt(2)
        self.assertEqual(lips.identify([(None, ambiguous, None)], protos), {})

    def test_speaker_assignment_requires_activity_unique_to_the_turn(self):
        observations = {4: {10: (120, 20), 11: (5, 20)}, 8: {10: (5, 20), 11: (125, 20)}}
        self.assertEqual(lips.speaker_mapping(observations), {4: 10, 8: 11})
        self.assertEqual(lips.speaker_mapping({4: {10: (120, 20), 11: (117, 20)}}), {})
        # An unrelated chewing listener moves just as much during the gaps.
        self.assertEqual(lips.speaker_mapping({4: {10: (120, 20)}}, {10: (60, 10)}), {})
        self.assertEqual(lips.speaker_mapping({4: {10: (35, 2)}}), {})

    def test_motion_rejects_global_lighting_but_detects_local_mouth_motion(self):
        rng = np.random.default_rng(47)
        prev = rng.integers(30, 190, size=(112, 112), dtype="uint8")
        same = prev + 15
        speaking = same.copy()
        speaking[86:100, 38:75] += 30
        self.assertLess(lips.mouth_motion(prev, same), .1)
        self.assertGreater(lips.mouth_motion(prev, speaking), 10)

    def test_orthogonal_display_rotation_and_mirroring(self):
        pixels = np.arange(6*8*3, dtype="uint8").reshape(6, 8, 3)
        frame = av.VideoFrame.from_ndarray(pixels, format="bgr24")
        np.testing.assert_array_equal(lips.oriented(frame, (90, False)), np.rot90(pixels))
        np.testing.assert_array_equal(lips.oriented(frame, (0, True)), pixels[::-1])
        np.testing.assert_array_equal(lips.oriented(frame, (-180, True)), pixels[:, ::-1])

    def test_chunked_speech_features_match_full_signal_across_block_boundary(self):
        rate = 16000
        time = np.arange(5 * rate) / rate
        wave = (.3 * np.sin(2*np.pi*240*time) * np.sin(2*np.pi*6*time)).astype("float32")
        wave[:2000] = 0
        wav = self.tmp/"speaker.wav"
        sf.write(wav, wave, rate, subtype="FLOAT")
        full = lfilter([1, -.97], [1], wave / np.max(np.abs(wave)))
        windows = np.lib.stride_tricks.sliding_window_view(np.pad(full, (400, 400)), 800)[::200]
        magnitude = abs(np.fft.rfft(windows*get_window("hann", 800), axis=1)).astype("float32")
        expected = np.clip(1.6*np.log10(np.maximum(np.einsum("bf,tf->bt", lips.mel_filters(), magnitude), 1e-5)) + 2.4, -4, 4)
        features = lips.VoiceFeatures()
        self.assertIsNone(features.at(wav, .02))
        for t in (.15, 3.95, 4., 4.1, 4.99):
            first = int((t-2/25)*80)
            bins = np.clip(np.arange(first, first+16), 0, expected.shape[1]-1)
            np.testing.assert_allclose(features.at(wav, t)[0, 0], expected[:, bins], atol=5e-4)
        # Contact at the beginning of an unpadded clip must replicate its edge,
        # not move the mel center ahead to compensate for missing history.
        immediate = self.tmp/"immediate.wav"
        sf.write(immediate, wave[3200:], rate, subtype="FLOAT")
        first = features.at(immediate, .02)[0, 0]
        for i in range(5):
            np.testing.assert_allclose(first[:, i], first[:, 0])
        quiet = self.tmp/"quiet-speaker.wav"
        sf.write(quiet, wave*.001, rate, subtype="FLOAT")
        np.testing.assert_allclose(features.at(quiet, 4.1), features.at(wav, 4.1), atol=5e-4)

    @unittest.skipUnless(shutil.which("ffmpeg"), "requires ffmpeg")
    def test_render_preserves_vfr_end_hold_with_no_translated_audio(self):
        source = self.tmp/"source.mp4"
        picture = self.tmp/"picture.mp4"
        voice = self.tmp/"mixed.wav"
        output = self.tmp/"dub.mp4"
        def media(*args):
            subprocess.run(["ffmpeg", "-v", "error", "-nostdin", "-y", *map(str, args)], check=True)
        media("-f", "lavfi", "-i", "testsrc2=s=48x32:r=4", "-t", 2, "-c:v", "libx264", "-bf", 0, picture)
        media("-i", picture, "-c:v", "copy", "-bsf:v", "setts=duration='if(eq(N,7),8*DURATION,DURATION)'", source)
        sf.write(voice, np.zeros(60000, dtype="float32"), 16000)
        with patch.object(lips, "FaceModels", side_effect=AssertionError), patch.object(lips, "progress"):
            self.assertEqual(lips.render(source, voice, [{"start": 1, "end": 2, "speaker": 0}], self.tmp, output, language="fr"), 0)
        def presentation(path):
            with av.open(path) as reader:
                return [(f.pts*f.time_base, f.duration*f.time_base) for f in reader.decode(video=0)]
        self.assertEqual(presentation(source), presentation(output))
        self.assertEqual(presentation(output)[-1][1], 2)
        with av.open(output) as reader:
            self.assertEqual([s.codec_context.name for s in reader.streams], ["h264", "aac"])
            self.assertEqual(reader.streams.audio[0].metadata["language"], "fra")
            self.assertEqual(reader.streams.audio[0].metadata["handler_name"], "Open EasyX Dubbed Audio")

    def test_only_aperture_is_synthesized_and_native_skin_is_warped(self):
        x, y = np.meshgrid(np.arange(160), np.arange(120))
        pixels = np.uint8((x*23 + y*11) % 120 + 100)
        original = np.repeat(pixels[:, :, None], 3, axis=2)
        outer = np.linspace(-np.pi, np.pi, 12, endpoint=False)
        inner = np.linspace(-np.pi, np.pi, 8, endpoint=False)
        def mouth(opening):
            return np.float32([(80+30*np.cos(t), 60+(6+opening)*np.sin(t)) for t in outer] +
                              [(80+25*np.cos(t), 60+opening*np.sin(t)) for t in inner])
        source, target = mouth(2), mouth(8)
        prediction = np.full_like(original, 20)
        actual = original.copy()
        self.assertTrue(lips.compose_mouth(actual, source, target, prediction, np.eye(2, 3)))
        np.testing.assert_array_equal(actual[:30], original[:30])
        np.testing.assert_array_equal(actual[:, :35], original[:, :35])
        # The newly exposed mouth interior comes from the prediction. Native
        # lip pigment and texture move with the contours above/below it.
        self.assertLess(actual[58:63, 70:90].max(), 35)
        self.assertGreater(actual[47:51, 76:84].mean(), 100)
        self.assertGreater(actual[47:51, 76:84].std(), 15)
        self.assertFalse(np.array_equal(actual[47:51, 76:84], original[47:51, 76:84]))

    def test_fitted_mouth_preserves_the_vowel_and_limits_inflation_in_the_face_plane(self):
        outer = np.linspace(-np.pi, np.pi, 12, endpoint=False)
        inner = np.linspace(-np.pi, np.pi, 8, endpoint=False)
        native = np.float32([(30*np.cos(t), 8*np.sin(t)) for t in outer] +
                            [(24*np.cos(t), 4*np.sin(t)) for t in inner])
        target = native * [1.35, 2.] + [9., 7.]
        fitted, transform = lips.fit_speaker_mouth(native, target, np.eye(2, 3))
        self.assertLessEqual(fitted[6, 0]-fitted[0, 0], 60*1.031)
        self.assertAlmostEqual(fitted[18, 1]-fitted[14, 1], target[18, 1]-target[14, 1], places=4)
        self.assertLessEqual(fitted[14, 1]-fitted[3, 1], 4*1.041)
        np.testing.assert_allclose(target[12:] @ transform[:, :2].T + transform[:, 2], fitted[12:], atol=1e-5)
        rot = np.array([[.8, -.6], [.6, .8]])
        move = [120., 80.]
        rotated, _ = lips.fit_speaker_mouth(native @ rot.T+move, target @ rot.T+move, np.eye(2, 3))
        np.testing.assert_allclose(rotated, fitted @ rot.T+move, atol=1e-5)
        rounded = native * [.7, 1.]
        same, _ = lips.fit_speaker_mouth(native, rounded, np.eye(2, 3))
        np.testing.assert_allclose(same, rounded, atol=1e-5)

    def test_open_native_reference_can_be_sealed_once_without_using_the_teeth(self):
        import cv2
        outer = np.linspace(-np.pi, np.pi, 12, endpoint=False)
        inner = np.linspace(-np.pi, np.pi, 8, endpoint=False)
        mouth = np.float32([(70+34*np.cos(t), 50+16*np.sin(t)) for t in outer] +
                           [(70+26*np.cos(t), 50+10*np.sin(t)) for t in inner])
        image = np.zeros((100,140,3), "uint8") + [95, 118, 143]
        image = image.astype("uint8")
        cv2.fillPoly(image, [mouth[:12].astype("int32")], (60, 72, 140))
        cv2.fillPoly(image, [mouth[12:].astype("int32")], (230, 230, 230))
        cheek = image[:18].copy()
        new, ok = lips.close_native_lips(image, mouth)
        self.assertTrue(ok)
        self.assertLess(cv2.contourArea(new[12:]), .02*cv2.contourArea(mouth[12:]))
        self.assertLess(image[49:51,62:78].mean(), 155)
        np.testing.assert_array_equal(cheek, image[:18])

    def test_texture_references_stay_with_the_visible_speaker_pose_and_material(self):
        import cv2
        outer = np.linspace(-np.pi, np.pi, 12, endpoint=False)
        inner = np.linspace(-np.pi, np.pi, 8, endpoint=False)
        mouth = np.float32([(70+34*np.cos(t), 50+16*np.sin(t)) for t in outer] +
                           [(70+26*np.cos(t), 50+10*np.sin(t)) for t in inner])
        pose = np.zeros(2, "float32")
        y, x = np.mgrid[:100, :140]
        enamel = 157+23*np.sin(x/5)+11*np.cos(y/7)
        native = np.repeat((enamel + 8*(2*(x%2)-1)).astype("uint8")[:, :, None], 3, axis=2)
        blurred = cv2.GaussianBlur(native, (0, 0), 1.8)
        bank = lips.MouthTextures()
        bank.collect(7, native, mouth, pose)
        self.assertIsNone(bank.choose(8, pose, blurred, mouth))
        self.assertIsNone(bank.choose(7, pose+[.55, 0], blurred, mouth))
        self.assertIsNone(bank.choose(7, pose, np.full_like(native, 25), mouth))
        self.assertIsNone(bank.choose(7, pose, blurred, lips.sealed_contour(mouth)))
        recovered = blurred.copy()
        baseline = blurred.copy()
        self.assertTrue(lips.compose_mouth(baseline, mouth, mouth, blurred, np.eye(2, 3)))
        self.assertTrue(lips.compose_mouth(recovered, mouth, mouth, blurred, np.eye(2, 3),
                                           texture=(bank, 7, pose)))
        ref = native[46:54, 61:79].astype("float32")
        before = np.mean(abs(baseline[46:54, 61:79]-ref))
        after = np.mean(abs(recovered[46:54, 61:79]-ref))
        self.assertLess(after, before*.75)
        np.testing.assert_array_equal(recovered[:26], baseline[:26])
        np.testing.assert_array_equal(recovered[:, :30], baseline[:, :30])
        # Under a tight ceiling a new speaker gets a slot; the old donor is
        # discarded, never reused for the new person's face.
        small = lips.MouthTextures(byte_budget=bank.stored_bytes+1)
        for speaker in range(10):
            small.collect(speaker, native, mouth, pose)
            self.assertLessEqual(small.stored_bytes, small.byte_budget)
        self.assertIsNone(small.choose(7, pose, blurred, mouth))
        self.assertIsNotNone(small.choose(9, pose, blurred, mouth))

    def test_dental_edge_restores_an_observed_enamel_boundary(self):
        import cv2
        outer = np.linspace(-np.pi, np.pi, 12, endpoint=False)
        inner = np.linspace(-np.pi, np.pi, 8, endpoint=False)
        mouth = np.float32([(70+36*np.cos(t), 50+17*np.sin(t)) for t in outer] +
                           [(70+29*np.cos(t), 50+11*np.sin(t)) for t in inner])
        native = np.full((100, 140, 3), [32, 42, 64], "uint8")
        native[44:54, 42:95] = [160, 162, 174]
        native[44:54, 65:67] = [88, 90, 100]
        blurred = cv2.GaussianBlur(native, (0, 0), 2.6)
        bank = lips.MouthTextures()
        pose = np.zeros(2, "float32")
        bank.collect(1, native, mouth, pose)
        result = bank.restore_enamel(1, pose, blurred, mouth, 70., blurred)
        def edge_slope(image):
            luma = cv2.cvtColor(image.astype("float32"), cv2.COLOR_BGR2GRAY)
            return abs(np.diff(luma[39:51, 50:60].mean(axis=1))).max()
        self.assertGreater(edge_slope(result), 1.5*edge_slope(blurred))
        self.assertLess(edge_slope(result), edge_slope(native))
        np.testing.assert_array_equal(result[:30], blurred[:30])
        np.testing.assert_array_equal(bank.restore_enamel(2, pose, blurred, mouth, 70., blurred), blurred)
        hidden = np.full_like(blurred, [22, 25, 80])
        np.testing.assert_array_equal(bank.restore_enamel(1, pose, hidden, mouth, 70., hidden), hidden)

    def test_source_tail_uses_aligned_pcm_and_stops_at_next_speaker(self):
        # A VAD-positive tail cannot continue into the next person's turn.
        path = self.tmp/"pcm.wav"
        sf.write(path, np.ones(32000, "float32")*.1, 16000)
        cues = [{"speaker": 1, "start": 0., "end": 1.},
                {"speaker": 2, "start": 1.12, "end": 1.5}]
        with patch("faster_whisper.vad.get_speech_timestamps", return_value=[{"start": 0, "end": 32000}]), \
             patch("av.open", side_effect=AssertionError):
            self.assertEqual(lips.source_speech_tails("unused", cues, {0}, path), {0: 1.12})

    def test_cached_256_model_responds_to_different_speech(self):
        root = Path(os.environ.get("EASYX_DUBBING_MODELS", ""))
        if not ((root/"models-3.3.0/edtalk_256.onnx").is_file() and (root/"models-3.0.0/peppa_wutz.onnx").is_file()):
            self.skipTest("requires explicitly cached EDTalk and lip landmark models")
        model = lips.LipModel()
        crop = np.random.default_rng(8).integers(0, 256, (256, 256, 3), dtype="uint8")
        a = model.predict(crop, np.zeros((1, 1, 80, 16), "float32"))
        b = model.predict(crop, np.full((1, 1, 80, 16), -4., "float32"))
        self.assertEqual(a.shape, crop.shape)
        self.assertGreater(np.abs(a[173:203, 100:157].astype("float32") - b[173:203, 100:157]).mean(), .2)

    def test_recover_fine_detail_only_when_visible_surfaces_match(self):
        y, x = np.mgrid[:60, :80]
        base = 145 + 35*np.sin(x/4) + 18*np.cos(y/6)
        detail = 10*(2*((x+y)%2)-1)
        source = np.repeat((base + detail).astype("uint8")[:, :, None], 3, axis=2)
        model = np.repeat(base.astype("uint8")[:, :, None], 3, axis=2)
        recovered = lips.restore_shared_texture(source, model, 70)
        self.assertLess(np.mean(abs(recovered-source)), .4*np.mean(abs(model.astype("float32")-source)))
        newly_open = np.full_like(model, 15)
        np.testing.assert_array_equal(lips.restore_shared_texture(source, newly_open, 70), newly_open)
