"""Deliver the selected picture and dubbed soundtrack together on the original timeline."""
import json
import math
import subprocess
from fractions import Fraction
from pathlib import Path
from tempfile import TemporaryDirectory

from runtime import ffmpeg, progress


def video_options(width, height, rate):
    # Keep source dimensions and timing. Bound bitrate bursts and the distance
    # to a random-access frame so playback can start and seek on slower links.
    kbps = round(5000 * width * height / (1920 * 1080))
    kbps = max(500, min(kbps, 18000))
    fps = float(rate) if rate else 30
    gop = max(1, min(240, round(2 * fps))) if math.isfinite(fps) else 60
    return {"crf": "17", "preset": "medium", "maxrate": f"{kbps}k", "bufsize": f"{kbps}k", "g": str(gop)}


def copy_duration(source, selector, kind):
    """Preserve the last MP4 sample when an empty edit delays a copied track."""
    probe = ["ffprobe", "-v", "error", "-select_streams", str(selector)]
    fields = "stream=start_pts,duration_ts,time_base,nb_frames:format=format_name"
    info = json.loads(subprocess.check_output([*probe, "-show_entries", fields, "-of", "json", str(source)]))
    stream = info["streams"][0]
    if ("mov" not in info["format"]["format_name"].split(",") or int(stream.get("start_pts", 0)) <= 0
            or not stream.get("nb_frames") or not stream.get("duration_ts")):
        return []
    base = Fraction(stream["time_base"])
    duration = int(stream["duration_ts"])
    # Older libavformat subtracts the presentation offset again when it
    # reports the last packet's duration. Read the native sample table.
    seek = max(0., float(duration*base)-1.)
    raw = json.loads(subprocess.check_output([
        *probe, "-ignore_editlist", "1", "-read_intervals", f"{seek:.6f}%", "-show_entries",
        "stream=duration_ts:packet=duration", "-of", "json", str(source),
    ]))
    packets = raw.get("packets", [])
    if int(raw["streams"][0].get("duration_ts", 0)) != duration or not packets or not packets[-1].get("duration"):
        return []  # An edit that also trims media has its own end.
    count = int(stream["nb_frames"])
    last = int(packets[-1]["duration"])
    expression = f"setts=pts=PTS:dts=DTS:duration='if(eq(N,{count-1}),{last}*{base}/TB,DURATION)'"
    return [f"-bsf:{kind}", expression]


def mux_dubbed_audio(picture, mixed_audio, output, *, video_offset, audio_offset, language, published_audio,
                     video_index=None):
    # A published dub is already on the player's timeline, including any audio edit list.
    shift = 0 if published_audio else audio_offset
    audio = ["-c:a", "copy"] if published_audio else ["-c:a", "aac", "-b:a", "192k"]
    if published_audio:
        audio += copy_duration(mixed_audio, "a:0", "a")
    video = copy_duration(picture, video_index, "v") if video_index is not None else []
    # Keep the AAC encoder's preroll even for delayed WAVs. Its first packet
    # can precede sample zero; dropping it damages the initial sound.
    if language:
        catalog = Path(__file__).resolve().parents[2] / "packages" / "translation-languages.json"
        codes = {item["code"]: item["nllb"].split("_")[0] for item in json.loads(catalog.read_text())}
        audio += ["-metadata:s:a:0", f"language={codes[language]}"]
    ffmpeg("-copyts", "-itsoffset", f"{video_offset:.9f}", "-i", picture,
           "-itsoffset", f"{shift:.9f}", "-i", mixed_audio, "-map", f"0:{video_index if video_index is not None else 'v:0'}", "-map", "1:a:0",
           "-c:v", "copy", *video, *audio, "-disposition:a:0", "default+dub",
           "-metadata:s:a:0", "handler_name=Open EasyX Dubbed Audio", "-avoid_negative_ts", "disabled",
           "-movie_timescale", "90000", "-movflags", "+faststart", output)


def encode_original_picture(source, index, output):
    import av
    from picture import PictureWriter, orientation, oriented, output_picture, timestamp, video_frames

    with av.open(str(source)) as src, av.open(str(output), "w") as dst:
        stream = src.streams[index]
        writer = None
        for frame in video_frames(src, stream):
            at = timestamp(frame, stream)
            if writer is None:
                start, transform = at, orientation(frame)
            if transform == (0, False) and frame.width % 2 == 0 and frame.height % 2 == 0:
                picture = frame.reformat(format="yuv420p", src_color_range=frame.color_range, dst_color_range=frame.color_range)
            else:
                picture = output_picture(frame, transform, oriented(frame, transform), None)
            if writer is None:
                writer = PictureWriter(dst, stream, picture, transform)
            writer.write(picture, frame, at-start)
        if writer is None:
            raise ValueError("No decodable video frames")
        writer.finish()
        return start


def mux_original_picture(source, mixed_audio, output, *, language, published_audio=False, prepare_recovery=None):
    metadata = json.loads(subprocess.check_output([
        "ffprobe", "-v", "error", "-show_entries",
        "stream=index,codec_type,codec_name,profile,pix_fmt,start_time:stream_disposition=attached_pic:format=start_time",
        "-of", "json", str(source),
    ]))
    streams = metadata["streams"]
    video = next((s for s in streams if s["codec_type"] == "video" and not s.get("disposition", {}).get("attached_pic")), None)
    audio = next((s for s in streams if s["codec_type"] == "audio"), None)
    if video is None or audio is None:
        raise ValueError("Dubbing requires both a video stream and an original audio stream")
    origin = metadata.get("format", {}).get("start_time", 0)
    video_start = float(video.get("start_time", origin))
    audio_start = float(audio.get("start_time", origin))
    compatible = (video["codec_name"] == "h264" and video.get("pix_fmt") in {"yuv420p", "yuvj420p"} and
                  video.get("profile") in {"Baseline", "Constrained Baseline", "Main", "High"})
    # A corrupt H.264 recording can pass header checks and even play its first picture.
    # Verify before copying the packets, otherwise recover its healthy pictures on their original clock.
    if compatible:
        compatible = subprocess.run([
            "ffmpeg", "-nostdin", "-v", "error", "-xerror", "-threads", "2", "-i", str(source),
            "-map", f"0:{video['index']}", "-fps_mode", "passthrough", "-f", "null", "-",
        ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
    if compatible:
        mux_dubbed_audio(source, mixed_audio, output, video_offset=-min(video_start, audio_start),
                         audio_offset=max(0, audio_start-video_start), language=language,
                         published_audio=published_audio, video_index=video["index"])
    else:
        if prepare_recovery is not None:
            prepare_recovery()
        progress("Encoding the original picture for playback", 92)
        with TemporaryDirectory(dir=Path(output).parent) as temp:
            picture = Path(temp)/"picture.mp4"
            video_start = encode_original_picture(source, video["index"], picture)
            mux_dubbed_audio(picture, mixed_audio, output, video_offset=max(0, video_start-audio_start),
                             audio_offset=max(0, audio_start-video_start), language=language, published_audio=published_audio)
    verify_playback(output)


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
