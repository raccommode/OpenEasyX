"""Check decoded source colors independently of the H.264 encoder."""
import importlib.util
import unittest

RUNTIME = all(importlib.util.find_spec(name) for name in ("av", "cv2", "numpy"))
if RUNTIME:
    import av
    import numpy as np
    from picture import output_picture, plane_view


@unittest.skipUnless(RUNTIME, "requires the optional dubbing Python environment")
class PictureTests(unittest.TestCase):
    def source(self):
        rng = np.random.default_rng(413)
        frame = av.VideoFrame(96, 72, "yuv420p")
        frame.color_range = 2
        frame.colorspace = 1
        for plane in frame.planes:
            pixels = plane_view(plane)
            pixels[:] = rng.integers(0, 256, pixels.shape, dtype="uint8")
        return frame

    def test_unedited_picture_keeps_native_samples_after_rotation_and_mirroring(self):
        src = self.source()
        bgr = src.to_ndarray(format="bgr24")
        rotated = np.rot90(bgr[::-1])
        out = output_picture(src, (90., True), rotated, None)
        self.assertEqual((out.width, out.height, out.color_range, out.colorspace), (72, 96, 2, 1))
        for a, b in zip(src.planes, out.planes):
            np.testing.assert_array_equal(plane_view(b), np.rot90(plane_view(a)[::-1]))

    def test_mouth_edit_preserves_even_out_of_rgb_gamut_samples_in_the_rest_of_the_picture(self):
        src = self.source()
        before = src.to_ndarray(format="bgr24")
        after = before.copy()
        after[32:42, 28:54] = [20, 20, 90]
        out = output_picture(src, (0., False), after, before)
        for i, (a, b) in enumerate(zip(src.planes, out.planes)):
            step = 2 if i else 1
            mask = np.ones((b.height, b.width), bool)
            mask[28//step:46//step, 24//step:58//step] = False
            np.testing.assert_array_equal(plane_view(b)[mask], plane_view(a)[mask])
        self.assertTrue(np.any(plane_view(src.planes[0])[32:42, 28:54] != plane_view(out.planes[0])[32:42, 28:54]))
