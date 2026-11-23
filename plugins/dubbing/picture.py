"""Composite mouth edits into the source picture before encoding the dubbed video."""
import av
import cv2
import numpy as np


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
