"""Validate the final MP4, including packet payloads and both stream clocks."""
import importlib.util
import json
import math
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import Mock, patch

import delivery


def ffmpeg(*args):
    subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-y", *map(str, args)], check=True)


def streams(path):
    return json.loads(subprocess.check_output(["ffprobe", "-v", "error", "-show_streams", "-of", "json", str(path)]))["streams"]


def packets(path, select, *, native=False):
    options = ["-ignore_editlist", "1"] if native else []
    return json.loads(subprocess.check_output([
        "ffprobe", "-v", "error", *options, "-select_streams", select, "-show_packets", "-show_data_hash", "sha256",
        "-show_entries", "packet=pts_time,dts_time,duration_time,data_hash", "-of", "json", str(path),
    ]))["packets"]


MODELS_RUNTIME = all(importlib.util.find_spec(name) for name in ("av", "cv2", "scipy", "onnxruntime", "soundfile"))
HAS_FFMPEG = shutil.which("ffmpeg") and shutil.which("ffprobe")


@unittest.skipUnless(HAS_FFMPEG, "requires ffmpeg and ffprobe")
class OriginalPictureTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.mix = self.tmp/"target.wav"
        ffmpeg("-f", "lavfi", "-i", "sine=880:duration=3:sample_rate=48000", self.mix)

    def source(self, video_start, audio_start, pixel_format="yuv420p"):
        picture, source = self.tmp/"picture.mp4", self.tmp/"source.mov"
        ffmpeg("-f", "lavfi", "-i", "testsrc2=s=96x64:r=8:d=1", "-vf", "select='not(eq(n,3))',setsar=2/1",
               "-fps_mode", "vfr", "-pix_fmt", pixel_format, "-c:v", "libx264", "-bf", "0",
               "-x264-params", "colorprim=bt709:transfer=bt709:colormatrix=bt709", picture)
        help_text = subprocess.check_output(["ffmpeg", "-hide_banner", "-h", "full"], stderr=subprocess.STDOUT)
        rotation = ["-display_rotation", "90"] if b"-display_rotation" in help_text else []
        legacy_rotation = [] if rotation else ["-metadata:s:v:0", "rotate=90"]
        ffmpeg("-copyts", "-itsoffset", video_start, *rotation, "-i", picture, "-itsoffset", audio_start,
               "-f", "lavfi", "-i", "sine=200:duration=2:sample_rate=48000", "-map", "0:v:0", "-map", "1:a:0",
               "-c:v", "copy", "-c:a", "pcm_s16le", "-bsf:v", "setts=duration='if(eq(N,6),6*DURATION,DURATION)'",
               *legacy_rotation, "-avoid_negative_ts", "disabled", "-movie_timescale", "90000", source)
        return source

    def assert_audio(self, path, start):
        import array
        tracks = streams(path)
        self.assertEqual([s["codec_name"] for s in tracks], ["h264", "aac"])
        audio = tracks[1]
        self.assertEqual(audio["tags"]["language"], "fra")
        packet_start = float(audio["start_time"])
        priming = round((start-packet_start)*48000)
        self.assertIn(priming, range(1025))
        self.assertAlmostEqual(packet_start+float(audio["duration"]), start+3, places=4)
        # Count cycles from the decoded track. The target tone is 880 Hz and the source is 200 Hz.
        samples = array.array("h", subprocess.check_output([
            "ffmpeg", "-v", "error", "-i", str(path), "-map", "0:a:0", "-f", "s16le", "-ac", "1", "-ar", "48000", "-",
        ]))
        samples = samples[priming:]
        # The first attack must also survive the encoder's priming window.
        expected = [4095*math.sin(2*math.pi*880*i/48000) for i in range(256)]
        gain = sum(x*y for x, y in zip(samples, expected))/sum(y*y for y in expected)
        self.assertAlmostEqual(gain, 1, delta=.1)
        crossings = sum(a < 0 <= b for a, b in zip(samples[4800:9600], samples[4801:9601]))
        self.assertIn(crossings, range(87, 90))

    def assert_video_clock(self, source, output, shift):
        inp, out = packets(source, "v:0"), packets(output, "v:0")
        self.assertEqual(len(inp), len(out))
        for a, b in zip(inp, out):
            self.assertAlmostEqual(float(a["pts_time"])+shift, float(b["pts_time"]), places=4)
        # FFmpeg 5 reports an incorrect final packet duration on a delayed
        # presentation clock. Inspect the encoded sample durations directly.
        native = packets(source, "v:0", native=True)
        copied = packets(output, "v:0", native=True)
        self.assertEqual(len(native), len(copied))
        self.assertEqual(float(native[-1]["duration_time"]), .75)
        for a, b in zip(native, copied):
            self.assertAlmostEqual(float(a["duration_time"]), float(b["duration_time"]), places=4)

    def test_compatible_h264_is_copied_with_rotation_color_vfr_and_the_selected_audio(self):
        source = self.source(.25, .75)
        output = self.tmp/"audio-only.mp4"
        with patch.object(delivery, "encode_original_picture", side_effect=AssertionError):
            recovery = Mock(side_effect=AssertionError)
            delivery.mux_original_picture(source, self.mix, output, language="fr", prepare_recovery=recovery)
            recovery.assert_not_called()
        self.assertEqual([p["data_hash"] for p in packets(source, "v:0")], [p["data_hash"] for p in packets(output, "v:0")])
        self.assert_video_clock(source, output, -.25)
        original, copied = streams(source)[0], streams(output)[0]
        for key in ["color_space", "color_range", "color_transfer", "color_primaries", "sample_aspect_ratio"]:
            self.assertEqual(original[key], copied[key])
        self.assertEqual(original["side_data_list"][0]["rotation"], 90)
        self.assertEqual(copied["side_data_list"][0]["rotation"], 90)
        self.assert_audio(output, .5)

    def test_delayed_b_frames_keep_both_clocks_and_their_native_sample_durations(self):
        picture, source, out = (self.tmp/name for name in ("gop.mp4", "delayed.mp4", "dub.mp4"))
        ffmpeg("-f", "lavfi", "-i", "testsrc2=s=96x64:r=12:d=1", "-c:v", "libx264", "-bf", "2",
               "-x264-params", "b-adapt=0:keyint=12", picture)
        ffmpeg("-copyts", "-itsoffset", "0.75", "-i", picture, "-i", self.mix,
               "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac",
               "-avoid_negative_ts", "disabled", "-movie_timescale", "90000", source)
        delivery.mux_original_picture(source, self.mix, out, language="fr")
        reference = packets(source, "v:0")
        self.assertTrue(any(p["pts_time"] != p["dts_time"] for p in reference))
        self.assertEqual(packets(out, "v:0"), reference)
        self.assertEqual(packets(out, "v:0", native=True), packets(source, "v:0", native=True))

    @unittest.skipUnless(MODELS_RUNTIME, "requires the optional dubbing Python environment")
    def test_changing_picture_mode_preserves_every_aac_packet_and_timestamp_in_both_directions(self):
        import lips
        for video_start, audio_start in [(.25, .75), (.75, .25)]:
            with self.subTest(video_start=video_start):
                source = self.source(video_start, audio_start)
                audio, lip_sync, again = [self.tmp/f"{mode}.mp4" for mode in ("audio", "lips", "again")]
                delivery.mux_original_picture(source, self.mix, audio, language="fr")
                with patch.object(lips, "progress"):
                    lips.render(source, audio, [], self.tmp, lip_sync, language="fr", published_audio=True)
                delivery.mux_original_picture(source, lip_sync, again, language="fr", published_audio=True)
                expected = packets(audio, "a:0")
                for output in (lip_sync, again):
                    self.assertEqual(packets(output, "a:0"), expected)
                    self.assertEqual(packets(output, "a:0", native=True), packets(audio, "a:0", native=True))
                    self.assert_audio(output, max(0, audio_start-video_start))
                    self.assert_video_clock(source, output, -min(video_start, audio_start))

    @unittest.skipUnless(MODELS_RUNTIME, "requires the optional dubbing Python environment")
    def test_incompatible_chroma_is_encoded_with_original_orientation_color_and_last_hold(self):
        source = self.source(.75, .25, pixel_format="yuv444p")
        output = self.tmp/"compatible.mp4"
        with patch.object(delivery, "progress"):
            recovery = Mock()
            delivery.mux_original_picture(source, self.mix, output, language="fr", prepare_recovery=recovery)
            recovery.assert_called_once_with()
        original, encoded = streams(source)[0], streams(output)[0]
        self.assertEqual(original["pix_fmt"], "yuv444p")
        self.assertEqual(encoded["pix_fmt"], "yuv420p")
        self.assertEqual((encoded["width"], encoded["height"]), (original["height"], original["width"]))
        self.assertEqual(encoded["sample_aspect_ratio"], "1:2")
        def visible_frame(path):
            return subprocess.check_output(["ffmpeg", "-v", "error", "-i", str(path), "-map", "0:v:0", "-frames:v", "1",
                                            "-vf", "scale=32:48", "-pix_fmt", "gray", "-f", "rawvideo", "-"])
        first, second = visible_frame(source), visible_frame(output)
        self.assertEqual(len(first), len(second))
        self.assertLess(sum(abs(a-b) for a, b in zip(first, second))/len(first), 4)
        for key in ["color_space", "color_range", "color_transfer", "color_primaries"]:
            self.assertEqual(original[key], encoded[key])
        self.assert_video_clock(source, output, -.25)
        self.assert_audio(output, 0)

    @unittest.skipUnless(MODELS_RUNTIME, "requires the optional dubbing Python environment")
    def test_damaged_h264_is_recovered_with_the_last_healthy_picture_held(self):
        source = self.source(0, 0)
        locations = json.loads(subprocess.check_output([
            "ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "packet=pos", "-of", "json", str(source),
        ]))["packets"]
        original_duration = float(streams(source)[0]["duration"])
        with source.open("r+b") as f:
            for packet in locations[-2:]:
                f.seek(int(packet["pos"]))
                f.write(b"\xff"*4)
        output = self.tmp/"recovered.mp4"
        with patch.object(delivery, "progress"):
            delivery.mux_original_picture(source, self.mix, output, language="fr")
        frames = packets(output, "v:0")
        self.assertEqual(len(frames), len(locations)-2)
        self.assertAlmostEqual(float(frames[-1]["pts_time"])+float(frames[-1]["duration_time"]), original_duration, places=4)
        self.assert_audio(output, 0)
