"""Composite mouth edits into the source picture before encoding the dubbed video."""
from fractions import Fraction

import av
import cv2
import numpy as np

from delivery import video_options


def plane_view(plane):
    return np.ndarray((plane.height, plane.width), dtype=np.uint8, buffer=plane, strides=(plane.line_size, 1))


def color_patch(pixels, frame):
    # Use the source matrix when libswscale exposes it; unspecified sources use its default.
    matrix = {1: 1, 4: 4, 5: 5, 6: 5, 7: 7, 9: 9, 10: 9}.get(frame.colorspace)
    rgb = av.VideoFrame.from_ndarray(np.ascontiguousarray(pixels), format="bgr24")
    yuv = rgb.reformat(format="yuv420p", dst_colorspace=matrix, dst_color_range=frame.color_range)
    yuv.color_range = frame.color_range
    yuv.colorspace = frame.colorspace
    return yuv


def output_picture(frame, transform, image, original):
    """Keep native YUV samples outside the edit, including sharp chroma edges and film grain."""
    h, w = image.shape[:2]
    angle, flip = transform
    quadrant = round(angle / 90)
    if h % 2 or w % 2 or abs(angle - quadrant * 90) >= .01:
        padded = cv2.copyMakeBorder(image, 0, h % 2, 0, w % 2, cv2.BORDER_REPLICATE)
        return color_patch(padded, frame)

    source = frame.reformat(format="yuv420p", src_color_range=frame.color_range, dst_color_range=frame.color_range)
    output = av.VideoFrame(w, h, "yuv420p")
    output.color_range = source.color_range
    output.colorspace = source.colorspace
    for src, dest in zip(source.planes, output.planes):
        pixels = plane_view(src)
        plane_view(dest)[:] = np.rot90(pixels[::-1] if flip else pixels, quadrant)
    if original is None:
        return output

    identical = cv2.inRange(cv2.absdiff(image, original), (0, 0, 0), (0, 0, 0))
    x, y, width, height = cv2.boundingRect(cv2.bitwise_not(identical))
    if not width or not height:
        return output
    # Give the chroma filter context and keep its subsampling grid aligned to the source.
    x0, y0 = max(0, (x - 4) // 2 * 2), max(0, (y - 4) // 2 * 2)
    x1, y1 = min(w, (x + width + 5) // 2 * 2), min(h, (y + height + 5) // 2 * 2)
    old = color_patch(original[y0:y1, x0:x1], source)
    new = color_patch(image[y0:y1, x0:x1], source)
    for i, dest in enumerate(output.planes):
        step = 1 if i == 0 else 2
        section = plane_view(dest)[y0//step:y1//step, x0//step:x1//step]
        delta = plane_view(new.planes[i]).astype(np.int16) - plane_view(old.planes[i])
        section[:] = np.clip(section + delta, 0, 255)
    return output


def orientation(frame):
    for side in frame.side_data:
        if side.type.name == "DISPLAYMATRIX":
            matrix = np.frombuffer(bytes(side), dtype=np.int32).reshape(3, 3)[:2, :2]
            angle = np.degrees(np.arctan2(-float(matrix[0, 1]), float(matrix[0, 0])))
            return angle, np.linalg.det(matrix.astype("float64")) < 0
    return 0., False


def oriented(frame, transform):
    image = frame.to_ndarray(format="bgr24")
    angle, flip = transform
    if flip:
        image = image[::-1, :]
    quadrant = round(angle / 90)
    if abs(angle - quadrant * 90) < .01:
        image = np.rot90(image, quadrant)
    elif angle:
        h, w = image.shape[:2]
        mat = cv2.getRotationMatrix2D((w/2, h/2), angle, 1)
        image = cv2.warpAffine(image, mat, (w, h))
    return np.ascontiguousarray(image)


def video_frames(container, stream):
    """Keep healthy pictures on their original clock even when packets are damaged."""
    previous = None
    damaged = False
    for packet in container.demux(stream):
        try:
            frames = packet.decode()
        except av.error.InvalidDataError:
            damaged = True
            continue
        for frame in frames:
            if frame.is_corrupt:
                damaged = True
                continue
            if previous is not None:
                yield previous
            previous = frame
    if previous is not None:
        if damaged and stream.duration is not None and stream.start_time is not None and previous.pts is not None:
            # A lost tail has no next picture to establish the last healthy frame's
            # duration. Hold it through the declared video end without shifting audio.
            end = (stream.start_time + stream.duration) * stream.time_base
            ticks = round(end / (previous.time_base or stream.time_base)) - previous.pts
            if ticks > 0:
                previous.duration = ticks
        yield previous


def timestamp(frame, stream):
    if frame.pts is None:
        raise ValueError("Video frames require presentation timestamps for synchronized dubbing")
    return float(frame.pts * (frame.time_base or stream.time_base))


class PictureWriter:
    """Write H.264 pictures with the source colour, display aspect and VFR sample durations."""
    def __init__(self, output, source, picture, transform):
        width, height = picture.width, picture.height
        rate = source.guessed_rate or source.average_rate or Fraction(25, 1)
        self.output = output
        self.durations = {}
        self.stream = output.add_stream("libx264", rate=rate, options=video_options(width, height, rate))
        self.stream.width, self.stream.height = width, height
        self.stream.pix_fmt = "yuv420p"
        codec = self.stream.codec_context
        for field in ("color_range", "colorspace", "color_trc", "color_primaries"):
            setattr(codec, field, getattr(source.codec_context, field))
        codec.time_base = Fraction(1, 90000)
        codec.max_b_frames = 0
        aspect = source.sample_aspect_ratio
        if aspect:
            codec.sample_aspect_ratio = 1/aspect if round(transform[0]/90) % 2 else aspect

    def write(self, picture, source_frame, elapsed):
        base = self.stream.codec_context.time_base
        pts = round(elapsed / float(base))
        if source_frame.duration:
            self.durations[pts] = round(source_frame.duration * source_frame.time_base / base)
        picture.time_base = base
        picture.pts = pts
        self._mux(self.stream.encode(picture))

    def finish(self):
        self._mux(self.stream.encode())

    def _mux(self, packets):
        for packet in packets:
            duration = self.durations.pop(packet.pts, 0)
            if duration:
                packet.duration = duration
            self.output.mux(packet)
