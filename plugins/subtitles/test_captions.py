import tempfile
import unittest
from pathlib import Path

import worker


class CaptionTests(unittest.TestCase):
    def test_vtt_preserves_speech_timing_and_literal_text(self):
        cues = [
            {"start": 1, "end": 12.3, "text": "A < B & C"},
            {"start": 12, "end": 12.75, "text": "Voilà."},
        ]
        track = worker.render_vtt(cues)
        self.assertIn("00:00:01.000 --> 00:00:12.000\nA &lt; B &amp; C", track)
        self.assertIn("00:00:12.000 --> 00:00:12.750\nVoilà.", track)

    def test_resume_only_reuses_an_intact_matching_checkpoint(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "chunk-000001.json"
            key = {"fingerprint": "111:old", "chunkSeconds": 120, "model": "small"}
            payload = {**key, "language": "fr", "probability": 0.97, "cues": [{"start": 121, "end": 122, "text": "Bonjour."}]}
            worker.save_transcript(path, payload)
            self.assertEqual(worker.load_transcript(path, key), payload)
            for changes in [{"fingerprint": "222:new"}, {"chunkSeconds": 600}, {"model": "tiny"}]:
                self.assertIsNone(worker.load_transcript(path, {**key, **changes}))
            path.write_text('{"fingerprint":', encoding="utf-8")
            self.assertIsNone(worker.load_transcript(path, key))


if __name__ == "__main__":
    unittest.main()
