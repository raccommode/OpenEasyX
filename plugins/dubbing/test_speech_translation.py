import importlib.util
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch


@unittest.skipUnless(all(importlib.util.find_spec(k) for k in ("soundfile", "torch", "transformers")), "requires the dubbing runtime")
class TranslationTests(unittest.TestCase):
    def test_separate_clips_and_transcript_fallback_preserve_overlapping_speaker_positions(self):
        import speech_translation as st
        import transformers
        cues = [dict(speaker=1, text="At eight", language="en", clip="1.flac", overlapping=True),
                dict(speaker=3, text="Here is the map", language="en", clip="3.flac", overlapping=True),
                dict(speaker=1, text="Merci", language="fr", clip="1b.flac")]
        with TemporaryDirectory() as tmp:
            path = Path(tmp)/"translation-fr.json"
            def fallback(rows, target, checkpoint):
                self.assertEqual(json.loads(checkpoint.read_text()), [None, "Voici la carte", "Merci"])
                return ["À huit heures", "Voici la carte", "Merci"]
            with patch.object(st, "model_path"), patch.object(st, "device", return_value="cpu"), \
                 patch.object(transformers.SeamlessM4Tv2ForSpeechToText, "from_pretrained"), \
                 patch.object(transformers.SeamlessM4TProcessor, "from_pretrained"), \
                 patch.object(st, "translate_line", side_effect=[None, "Voici la carte"]) as generate, \
                 patch.object(st, "translate", side_effect=fallback):
                expected = ["À huit heures", "Voici la carte", "Merci"]
                self.assertEqual(st.translate_speech(cues, "fr", Path(tmp), path), expected)
                self.assertEqual([c.args[2]["clip"] for c in generate.call_args_list], ["1.flac", "3.flac"])
                self.assertEqual(st.translate_speech(cues, "fr", Path(tmp), path), expected)
                self.assertEqual(generate.call_count, 2)
    def test_audio_translation_does_not_lose_a_number_or_adopt_the_other_speaker(self):
        import numpy as np
        import soundfile as sf
        import torch
        import speech_translation as st
        with TemporaryDirectory() as temp:
            work = Path(temp)
            sf.write(work/"line.flac", np.ones(16000)*.2, 16000)
            for text, heard, foreign in [("At 8", "At 8", "Un jour"), ("Get the map", "Buy the ticket", "Le billet")]:
                cue = dict(clip="line.flac", text=text, language="en", overlapping=True)
                processor, model = Mock(), Mock()
                processor.return_value.to.return_value = {}
                model.generation_config = SimpleNamespace(text_decoder_lang_to_code_id={"eng": 1})
                processor.batch_decode.side_effect = [[foreign], [heard]]
                self.assertIsNone(st.translate_line(model, processor, cue, work, "fr", "cpu", torch.float32))

    def test_timing_cache_matches_the_exact_published_take_and_keeps_overlaps(self):
        import numpy as np
        import soundfile as sf
        from sync_cache import keep, restore, move
        with TemporaryDirectory() as temp:
            work = Path(temp)
            wavs = work/"wavs"
            wavs.mkdir()
            cues = [dict(start=0,end=1,speaker=7),dict(start=.4,end=1.4,speaker=2),dict(start=4,end=5,speaker=7)]
            for i in range(2):
                sf.write(wavs/f"{i}.wav", (.2+i*.1)*np.ones(24000), 24000)
            job = dict(language="fr", speechCacheDir=str(work/"timing"))
            previous, new = work/"old.mp4", work/"new.mp4"
            previous.write_bytes(b"first")
            new.write_bytes(b"second")
            keep(job, previous, cues, wavs)
            restored = work/"restored"
            restored.mkdir()
            self.assertIsNone(restore(job, new, restored))
            move(job, previous, new)
            actual = restore(job, new, restored)
            self.assertEqual([c["speaker"] for c in actual], [7,2,7])
            self.assertEqual([c["translated"] for c in actual], [True,True,False])
            self.assertAlmostEqual(sf.read(restored/"0.wav")[0][500], .2, places=3)
            self.assertAlmostEqual(sf.read(restored/"1.wav")[0][500], .3, places=3)

if __name__ == "__main__":
    unittest.main()
