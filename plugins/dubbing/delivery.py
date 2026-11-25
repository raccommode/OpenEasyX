"""Encode the dubbed picture for seekable, bandwidth-bounded MP4 playback."""
import json
import math
import subprocess
from fractions import Fraction

from runtime import progress


def video_options(width, height, rate):
    # Keep source dimensions and timing. Bound bitrate bursts and the distance
    # to a random-access frame so playback can start and seek on slower links.
    kbps = round(5000 * width * height / (1920 * 1080))
    kbps = max(500, min(kbps, 18000))
    fps = float(rate) if rate else 30
    gop = max(1, min(240, round(2 * fps))) if math.isfinite(fps) else 60
    return {"crf": "17", "preset": "medium", "maxrate": f"{kbps}k", "bufsize": f"{kbps}k", "g": str(gop)}


def verify_playback(output, expected_frames=None):
    streams = json.loads(subprocess.check_output([
        "ffprobe", "-v", "error", "-show_entries", "stream=codec_type,codec_name,nb_frames",
        "-of", "json", str(output),
    ]))["streams"]
    video = next((s for s in streams if s.get("codec_name") == "h264"), {})
    count = int(video.get("nb_frames") or 0)
    if count < 1 or not any(s.get("codec_name") == "aac" for s in streams):
        raise ValueError("The dubbed MP4 is missing its video frames or AAC audio")
    if expected_frames is not None and count != expected_frames:
        raise ValueError(f"The optimized dub contains {count} of {expected_frames} published frames")
    # A stream entry in the MP4 index alone does not prove the browser can display a picture.
    pixel = subprocess.check_output(["ffmpeg", "-nostdin", "-v", "error", "-i", str(output),
                                     "-map", "0:v:0", "-frames:v", "1", "-vf", "scale=1:1",
                                     "-pix_fmt", "gray", "-f", "rawvideo", "pipe:1"])
    if len(pixel) != 1:
        raise ValueError("The first picture of the dubbed MP4 could not be decoded")


def optimize_published(source, output):
    # This is already a synchronized render. Reuse its picture clock and copy
    # the published AAC packets, including encoder priming and language tags.
    metadata = json.loads(subprocess.check_output([
        "ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
        "stream=width,height,avg_frame_rate,r_frame_rate,nb_frames,duration", "-of", "json", str(source),
    ]))
    stream = metadata["streams"][0]
    rate = next((Fraction(stream[key]) for key in ("avg_frame_rate", "r_frame_rate")
                 if stream.get(key) not in (None, "0/0", "0/1")), Fraction(30))
    options = video_options(stream["width"], stream["height"], rate)
    command = ["ffmpeg", "-nostdin", "-v", "error", "-y", "-progress", "pipe:1", "-copyts", "-i", str(source),
               "-map", "0:v:0", "-map", "0:a:0", "-c:v", "libx264",
               *(arg for name, value in options.items() for arg in ("-" + name, value)),
               "-threads:v", "2", "-bf", "0", "-pix_fmt", "yuv420p", "-fps_mode", "passthrough",
               "-enc_time_base:v", "1:90000", "-c:a", "copy", "-avoid_negative_ts", "disabled",
               "-movie_timescale", "90000", "-movflags", "+faststart", str(output)]
    duration = float(stream["duration"])
    last = 10
    with subprocess.Popen(command, stdout=subprocess.PIPE, text=True) as child:
        for line in child.stdout:
            key, _, value = line.strip().partition("=")
            if key == "out_time_us" and value.isdigit() and duration > 0:
                percent = min(98, 10 + int(88 * int(value) / (duration * 1_000_000)))
                if percent > last:
                    progress("Optimizing the published dub for playback", percent)
                    last = percent
        if child.wait():
            raise RuntimeError(f"FFmpeg could not optimize the published dub (exit {child.returncode})")
    verify_playback(output, int(stream["nb_frames"]))
