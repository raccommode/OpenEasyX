"""Associate visible speaking faces with diarized voices, then animate each mouth from its own dub."""
from bisect import bisect_left, bisect_right
from collections import defaultdict
from fractions import Fraction
from functools import cached_property, lru_cache
import json
from math import gcd
from pathlib import Path
from tempfile import TemporaryDirectory

import av
import cv2
import numpy as np
import onnxruntime as ort
import soundfile as sf
from scipy.optimize import linear_sum_assignment
from scipy.signal import get_window, lfilter, resample_poly
from scipy.spatial import Delaunay, QhullError

from picture import output_picture
from mouth_geometry import fit_speaker_mouth
from mouth_texture import MouthTextures
from runtime import ffmpeg, model_path, progress


class Timeline:
    """Advance through overlapping turns without scanning the full transcript per frame."""
    def __init__(self, cues):
        self.turns = sorted(enumerate(cues), key=lambda item: item[1]["start"])
        self.next = 0
        self.active = {}

    def at(self, t):
        while self.next < len(self.turns) and self.turns[self.next][1]["start"] <= t:
            i, cue = self.turns[self.next]
            self.active[i] = cue
            self.next += 1
        self.active = {i: cue for i, cue in self.active.items() if cue["end"] > t}
        return self.active


class FaceModels:
    def __init__(self):
        cv2.setNumThreads(1)
        self.detector = cv2.FaceDetectorYN.create(model_path("detector", "face_detection_yunet_2023mar.onnx"), "", (640, 640), .80)
        self.recognizer = cv2.FaceRecognizerSF.create(model_path("face", "face_recognition_sface_2021dec_int8.onnx"), "")

    def detect(self, image, *, relaxed=False):
        h, w = image.shape[:2]
        scale = min(1., 768 / max(w, h))
        small = cv2.resize(image, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA) if scale < 1 else image
        self.detector.setInputSize(small.shape[1::-1])
        if relaxed:
            self.detector.setScoreThreshold(.55)
        try:
            _, rows = self.detector.detect(small)
        finally:
            if relaxed:
                self.detector.setScoreThreshold(.80)
        faces = []
        for row in (() if rows is None else rows):
            row = row.copy()
            row[:14] /= scale
            if min(row[2:4]) < 28:
                continue
            faces.append(self.describe(image, row))
        return faces

    def describe(self, image, row):
        aligned = self.recognizer.alignCrop(image, row)
        embedding = self.recognizer.feature(aligned).reshape(-1).copy()
        embedding /= max(np.linalg.norm(embedding), 1e-8)
        return row, embedding, cv2.cvtColor(aligned, cv2.COLOR_BGR2GRAY)


def identify(faces, prototypes):
    """One visible face per identity. Reject close competing matches."""
    identities = {}
    if prototypes and faces:
        scores = np.array([[np.max(prototype @ face[1]) for prototype in prototypes] for face in faces])
        rows, cols = linear_sum_assignment(-scores)
        for row, col in zip(rows, cols):
            score = scores[row, col]
            others = np.delete(scores[row], col)
            if score >= .45 and (not others.size or score >= others.max() + .045):
                identities[int(row)] = int(col)
    return identities


class FaceTracks:
    """Carry compatible appearances through gradual pose changes, never across a cut to a different face."""
    def __init__(self):
        self.previous = {}

    def identify(self, faces, prototypes, t, learn=False):
        ids = identify(faces, prototypes)
        links = {}
        for i, (box, vector, crop) in enumerate(faces):
            matches = []
            for identity, (at, old_box, old_vector, old_crop) in self.previous.items():
                if 0 < t-at < .32 and same_face_position(box, old_box) and vector @ old_vector >= .55:
                    # A continuous upper face remains recognizable even when the mouth changes shape.
                    upper = np.s_[30:79, 20:92]
                    if crop[upper].std() >= 3 and cv2.matchTemplate(crop[upper], old_crop[upper], cv2.TM_CCOEFF_NORMED)[0, 0] >= .60:
                        matches.append(identity)
            if len(matches) == 1:
                links[i] = matches[0]
        for i, identity in links.items():
            if identity in (v for j, v in ids.items() if j != i) or list(links.values()).count(identity) != 1:
                continue
            if i in ids and ids[i] != identity:
                continue
            ids[i] = identity
            if learn:
                vector = faces[i][1]
                examples = np.atleast_2d(prototypes[identity])
                if len(examples) < 12 and np.max(examples @ vector) < .77:
                    prototypes[identity] = np.vstack((examples, vector))
        if learn:
            for i, (_, vector, _) in enumerate(faces):
                if i not in ids and len(prototypes) < 128 and all(np.max(old @ vector) < .38 for old in prototypes):
                    ids[i] = len(prototypes)
                    prototypes.append(vector)
        self.previous = {identity: (t, *faces[i]) for i, identity in ids.items()}
        return ids


def follow_face(previous, current, row, scale):
    """Track eyes, nose and upper cheek texture through a short detector miss."""
    x,y,w,h = row[:4]*scale
    mask = np.zeros_like(previous)
    cv2.ellipse(mask, (round(x+.50*w), round(y+.43*h)), (max(2, round(.38*w)), max(2, round(.28*h))), 0, 0, 360, 255, -1)
    points = cv2.goodFeaturesToTrack(previous, 35, .015, 3, mask=mask)
    if points is None or len(points)<8:
        return None
    forward, ok, error = cv2.calcOpticalFlowPyrLK(previous, current, points, None)
    reverse, back, _ = cv2.calcOpticalFlowPyrLK(current, previous, forward, None)
    valid = (ok[:,0]>0) & (back[:,0]>0) & (error[:,0]<18) & (np.linalg.norm(reverse-points, axis=2)[:,0]<1.)
    if valid.sum() < 8:
        return None
    mat, inliers = cv2.estimateAffinePartial2D(points[valid], forward[valid], method=cv2.RANSAC, ransacReprojThreshold=1.5)
    if mat is None or inliers.sum()<max(7,.65*len(points[valid])) or not .82 < mat[0,0] < 1.22 or abs(mat[0,1])>.26:
        return None
    mat[:,2] /= scale
    x,y,w,h = row[:4]
    corners = np.float32([[x,y],[x+w,y],[x+w,y+h],[x,y+h]])
    corners = cv2.transform(corners[None], mat)[0]
    tracked = row.copy()
    tracked[:2], tracked[2:4] = corners.min(0), np.ptp(corners, axis=0)
    tracked[4:14] = cv2.transform(row[4:14].reshape(1,5,2), mat).ravel()
    return tracked if same_face_position(row, tracked) else None


class FaceContinuity:
    def __init__(self):
        self.gray = None
        self.observed = {}

    def recover(self, image, faces, ids, active, t, describe, owners):
        if describe is None:
            return
        scale = min(1., 640/max(image.shape[:2]))
        small = cv2.resize(image, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA) if scale<1 else image
        gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
        observed = {identity: (t, faces[i]) for i, identity in ids.items() if identity in active}
        for identity, (last, old) in self.observed.items():
            if identity in observed or identity not in active or t-last > .24 or self.gray is None:
                continue
            row = follow_face(self.gray, gray, old[0], scale)
            if row is None:
                continue
            overlapping = [i for i, f in enumerate(faces) if same_face_position(row, f[0])]
            if len(overlapping)>1:
                continue
            if overlapping:
                i = overlapping[0]
                if ids.get(i) in owners or ids.get(i) in active or faces[i][1] @ old[1] < .45:
                    continue
                face = faces[i]
            else:
                face = describe(image, row)
                if face[1] @ old[1] < .48:
                    continue
                i = len(faces)
                faces.append(face)
            ids[i] = identity
            observed[identity] = (last, face)
        self.gray, self.observed = gray, observed


def mouth_motion(previous, current):
    """Measure local articulation after face alignment, discounting motion elsewhere on the face."""
    # Small changes in the detected landmarks can shift the aligned crop by several
    # pixels. Register on the upper face, excluding the moving mouth from the fit.
    matrix = np.eye(2, 3, dtype=np.float32)
    mask = np.zeros_like(previous)
    mask[30:79, 20:92] = 255
    try:
        score, matrix = cv2.findTransformECC(previous, current, matrix, cv2.MOTION_AFFINE,
            (cv2.TERM_CRITERIA_COUNT | cv2.TERM_CRITERIA_EPS, 12, .0001), mask, 3)
        if score > .7 and np.max(np.abs(matrix[:, :2] - np.eye(2))) < .20 and np.max(np.abs(matrix[:, 2])) < 12:
            previous = cv2.warpAffine(previous, matrix, (112, 112), borderMode=cv2.BORDER_REPLICATE)
    except cv2.error:
        # A blank or abruptly occluded face does not provide reliable motion evidence.
        return 0.
    diff = current.astype("float32") - previous
    diff = abs(diff - np.median(diff[34:76, 20:92]))
    return max(0., float(diff[87:99, 39:74].mean() - 1.4 * diff[43:74, 23:89].mean()))


class MotionHistory:
    def __init__(self):
        self.previous = {}

    def observe(self, t, faces, identities):
        scores = {}
        fresh = {}
        for i, identity in identities.items():
            crop = faces[i][2]
            if identity in self.previous:
                last_time, previous = self.previous[identity]
                if t - last_time < .09:
                    fresh[identity] = (last_time, previous)
                    continue
                if 0 < t - last_time < .35:
                    scores[identity] = mouth_motion(previous, crop)
            fresh[identity] = (t, crop)
        self.previous = fresh
        return scores


def speaker_mapping(observations, quiet=None):
    """Vote on solo turns. Overlaps use identities learned on unambiguous turns."""
    speakers = sorted(observations)
    faces = sorted({face for data in observations.values() for face in data})
    if not speakers or not faces:
        return {}
    scores = np.zeros((len(speakers), len(faces)))
    for row, speaker in enumerate(speakers):
        for col, face in enumerate(faces):
            total, visible = observations[speaker].get(face, (0, 0))
            # A short glimpse of a moving listener must not dominate a whole speaking turn.
            if visible >= 3:
                resting, count = (quiet or {}).get(face, (0., 0))
                baseline = resting / count if count >= 5 else 0.
                scores[row, col] = max(0., total / (visible + 6) - baseline)
    rows, cols = linear_sum_assignment(-scores)
    result = {}
    for r, c in zip(rows, cols):
        score = scores[r, c]
        rivals = np.r_[np.delete(scores[r], c), np.delete(scores[:, c], r)]
        if score > .75 and (not rivals.size or score > rivals.max() * 1.30 + .12):
            result[speakers[r]] = faces[c]
    return result


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


def video_clock(container):
    video = container.streams.video[0]
    audio = container.streams.audio[0] if container.streams.audio else video
    origin = float(audio.start_time * audio.time_base) if audio.start_time is not None else float(container.start_time or 0) / av.time_base
    duration = float(video.duration * video.time_base) if video.duration else float(container.duration or 0) / av.time_base
    return video, origin, duration


def timestamp(frame, stream):
    if frame.pts is None:
        raise ValueError("Video frames require presentation timestamps for synchronized dubbing")
    return float(frame.pts * (frame.time_base or stream.time_base))


def mux_frames(output, encoder, durations, frame=None):
    for packet in encoder.encode(frame):
        # The decoder supplies a duration for the last VFR frame too. Encoders
        # otherwise infer a nominal last-frame duration from the average rate.
        duration = durations.pop(packet.pts, 0)
        if duration:
            packet.duration = duration
        output.mux(packet)


class SpeakerAnchors(defaultdict):
    def __init__(self):
        super().__init__(list)
        self.local = {}
        self.solo = {}

    def face(self, cue, t, global_face):
        votes = self.local.get(cue)
        if votes is None:
            return global_face
        frame = round(t*25)
        for offset in (0, -1, 1, -2, 2, -3, 3):
            if frame+offset in votes:
                return votes[frame+offset]
        return None

    def match_solo(self, idx, t, image, models, faces, ids, identity, owners):
        observations = self.solo.get(idx)
        if not observations or not hasattr(models, "describe") or len(faces)>1:
            return
        pos = bisect_left(observations, t, key=lambda r:r[0])
        nearby = [r for r in observations[max(0,pos-2):pos+2] if abs(r[0]-t)<=.22]
        if not nearby:
            return
        if 0 < pos < len(observations):
            before, after = observations[pos-1:pos+1]
            if before[0] < t < after[0] and before[2] @ after[2] < .30:
                return
        options = faces if faces else models.detect(image, relaxed=True)
        if not options and 0 < pos < len(observations):
            left, right = observations[pos-1:pos+1]
            if right[0]-left[0]<=.28 and same_face_position(left[1],right[1]):
                f = (t-left[0])/(right[0]-left[0])
                options = [models.describe(image, np.float32((1-f)*left[1]+f*right[1]))]
        if len(options)!=1 or (ids.get(0) in owners and ids[0]!=identity):
            return
        candidate = options[0]
        scores = [candidate[1] @ vector for _,row,vector in nearby if same_face_position(row,candidate[0])]
        if not scores or max(scores)<.48:
            return
        if not faces:
            faces.append(candidate)
        ids[0] = identity


def learn_speakers(source, cues, models, lip_model=None, anchors=None, source_audio=None):
    prototypes = []
    evidence = defaultdict(lambda: defaultdict(lambda: [0., 0]))
    quiet = defaultdict(lambda: [0., 0])
    candidates = defaultdict(lambda: defaultdict(list))
    solo = defaultdict(list)
    multiple = set()
    turns, history, tracking = Timeline(cues), MotionHistory(), FaceTracks()
    last_turn = max(c["end"] for c in cues)
    next_sample, last_report = -float("inf"), -1
    last_active, previous_speaker = -float("inf"), None
    with av.open(str(source)) as src:
        stream, origin, duration = video_clock(src)
        transform = None
        for frame in src.decode(stream):
            t = timestamp(frame, stream) - origin
            if t >= last_turn + 1:
                break
            if transform is None:
                transform = orientation(frame)
            if t < next_sample:
                continue
            next_sample = t + .10
            active_cues = turns.at(t)
            active = {cue["speaker"] for cue in active_cues.values()}
            if active:
                last_active = t
            if len(active) > 1 or t - last_active > 1:
                history.previous.clear()
                continue
            speaker = next(iter(active), None)
            if speaker != previous_speaker:
                history.previous.clear()
            previous_speaker = speaker
            image = oriented(frame, transform)
            faces = models.detect(image)
            ids = tracking.identify(faces, prototypes, t, learn=speaker is not None)
            if isinstance(anchors, SpeakerAnchors) and len(active_cues) == 1:
                idx = next(iter(active_cues))
                for i, identity in ids.items():
                    candidates[idx][identity].append((t, faces[i][0][:4].copy()))
                if len(faces)==1:
                    row, vector, _ = faces[0]
                    solo[idx].append((t, row, vector))
                elif len(faces)>1:
                    multiple.add(idx)
            if lip_model is not None:
                for i, identity in ids.items():
                    lip_model.collect_rest(identity, image, faces[i][0], t)
            observed = quiet if speaker is None else evidence[speaker]
            for identity, motion in history.observe(t, faces, ids).items():
                if motion > .65 and anchors is not None:
                    row = faces[next(i for i, value in ids.items() if value == identity)][0]
                    for idx in active_cues:
                        anchors[idx, identity].append((t, row[:4].copy()))
                count = observed[identity]
                count[0] += min(motion, 20)
                count[1] += 1
            done = int(70 + 10 * np.clip(t / max(duration, .01), 0, 1))
            if done > last_report:
                progress("Matching visible speakers", done)
                last_report = done
    speakers = speaker_mapping(evidence, quiet)
    if isinstance(anchors, SpeakerAnchors):
        from active_speaker import confirm_candidates
        anchors.local = confirm_candidates(source, source_audio, candidates, anchors, speakers, cues,
                                          {i:samples for i,samples in solo.items() if i not in multiple})
    return prototypes, speakers


@lru_cache(maxsize=1)
def mel_filters():
    from librosa.filters import mel
    return mel(sr=16000, n_fft=800, n_mels=80, fmin=55, fmax=7600)


class PhraseActivity:
    """Audible phonation on a 10 ms clock, independent of padding and playback gain."""
    def __init__(self, path):
        energy = []
        self.peak = 0.
        self.spans = []
        with sf.SoundFile(path) as src:
            self.duration = len(src) / src.samplerate
            hop = max(1, round(src.samplerate*.01))
            self.step = hop/src.samplerate
            for block in src.blocks(blocksize=hop*512, dtype="float32", always_2d=True):
                if not block.size:
                    continue
                wave = block.mean(axis=1)
                self.peak = max(self.peak, float(np.max(np.abs(wave))))
                wave = np.pad(wave, (0, -len(wave) % hop)).reshape(-1, hop)
                energy.extend(np.sqrt(np.mean(wave**2, axis=1)))
        energy = np.asarray(energy)
        if self.peak < 1e-7 or not energy.size:
            self.active = np.zeros(0, bool)
            return
        strong = energy[energy > .025*energy.max()]
        level = np.percentile(strong, 85)
        active = energy > max(level*.018, energy.max()*.006)
        edges = np.diff(np.r_[False, active, False].astype(int))
        spans = []
        for left, right in zip(np.flatnonzero(edges==1), np.flatnonzero(edges==-1)):
            if right-left < 2:
                continue
            if spans and left-spans[-1][1] <= 6:
                spans[-1][1] = right
            else:
                spans.append([left, right])
        self.active = np.zeros(len(active), bool)
        for left, right in spans:
            first, last = max(0, left-1), min(len(active), right+2)
            self.active[first:last] = True
            self.spans.append((first*self.step, min(last*self.step, self.duration)))

    def articulation(self, t):
        """Ease between rest and speech without smoothing adjacent phonemes."""
        pos = bisect_right(self.spans, (t, float("inf"))) - 1
        if pos < 0:
            return 0.
        start, end = self.spans[pos]
        duration = end - start
        if t >= end or duration <= 0:
            return 0.
        attack, release = min(.090, duration/3), min(.065, duration/3)
        u = min(1., (t-start)/attack, (end-t)/release)
        return u*u*(3-2*u)

    def audible(self, t):
        i = int(t/self.step)
        return t >= 0 and i < len(self.active) and self.active[i]


class VoiceFeatures:
    """Read four seconds plus STFT context at a time, including for long individual WAVs."""
    def __init__(self):
        self.phrase = lru_cache(maxsize=8)(PhraseActivity)
        self.block = lru_cache(maxsize=4)(self._block)

    def _block(self, path, number):
        start = number * 64000
        with sf.SoundFile(path) as src:
            rate = src.samplerate
            left = max(0, (start - 600) * rate // 16000)
            right = min(len(src), (start + 64000 + 4000) * rate // 16000)
            if right <= left:
                return np.empty((80, 0), np.float32)
            src.seek(left)
            wave = src.read(right-left, dtype="float32", always_2d=True).mean(axis=1)
            wave /= max(self.phrase(path).peak, 1e-6)
        if rate != 16000:
            g = gcd(rate, 16000)
            wave = resample_poly(wave, 16000//g, rate//g)
        offset = start - round(left * 16000 / rate)
        emphasized = lfilter([1, -.97], [1], wave).astype("float32")
        padded = np.pad(emphasized, (max(0, 400-offset), 4400))[max(0, offset-400):]
        windows = np.lib.stride_tricks.sliding_window_view(padded, 800)[::200]
        spectrum = abs(np.fft.rfft(windows * get_window("hann", 800), axis=1)).astype("float32")
        mel = np.einsum("bf,tf->bt", mel_filters(), spectrum)
        mel = np.clip(1.6 * np.log10(np.maximum(mel, 1e-5)) + 2.4, -4, 4).astype("float32")
        return mel

    def at(self, path, seconds):
        phrase = self.phrase(path)
        if not phrase.audible(seconds):
            return None
        # EDTalk uses a 16-bin context starting two 25 fps training frames
        # before the image, with edge replication at either end of a clip.
        first = int((seconds-2/25)*80)
        number = max(first, 0)//320
        mel = self.block(path, number)
        last = int(phrase.duration*80)
        bins = np.clip(np.arange(first, first+16), 0, last) - number*320
        return mel[:, bins][None, None]


def restore_shared_texture(warped, inside, width):
    """Transfer fine detail only where native and synthesized structures agree locally."""
    native = warped.astype("float32")
    generated = inside.astype("float32")
    sigma = max(1., min(3., .017 * width))
    low_native = cv2.GaussianBlur(native, (0, 0), sigma)
    low_generated = cv2.GaussianBlur(generated, (0, 0), sigma)
    gray_n = cv2.cvtColor(low_native, cv2.COLOR_BGR2GRAY)
    gray_g = cv2.cvtColor(low_generated, cv2.COLOR_BGR2GRAY)

    def local_mean(values):
        return cv2.GaussianBlur(values, (0, 0), sigma*2)

    mn, mg = local_mean(gray_n), local_mean(gray_g)
    covariance = local_mean(gray_n*gray_g) - mn*mg
    variance = np.maximum(local_mean(gray_n**2) - mn**2, 0) * np.maximum(local_mean(gray_g**2) - mg**2, 0)
    similar = np.clip((covariance / np.sqrt(variance + 16) - .45) / .45, 0, 1)
    similar *= np.clip(1 - np.mean(abs(low_native-low_generated), axis=2)/45, 0, 1)
    detail = (native-low_native) - (generated-low_generated)
    return np.clip(generated + similar[:, :, None]*np.clip(detail, -24, 24), 0, 255)


def compose_mouth(image, original, target, predicted, prediction_to_image, *, resting=False, texture=None):
    """Move native lip and skin pixels to the new shape. Synthesize the exposed oral cavity."""
    width = np.linalg.norm(original[0] - original[6])
    if width < 5 or not .45 * width <= np.linalg.norm(target[0] - target[6]) <= 1.7 * width:
        return False
    if np.linalg.norm(original.mean(axis=0) - target.mean(axis=0)) > .4 * width:
        return False
    mouth = np.concatenate((original, target))
    left, top = np.maximum(0, np.floor(mouth.min(0) - .25*width).astype(int))
    right, bottom = np.minimum(image.shape[1::-1], np.ceil(mouth.max(0) + .25*width).astype(int) + 1)
    w, h = right-left, bottom-top
    if w < 3 or h < 3:
        return False
    origin = np.float32([left, top])
    # Fixed anchors taper the displacement back to zero in the surrounding skin.
    border = np.float32([[0, 0], [.5, 0], [1, 0], [1, .5], [1, 1], [.5, 1], [0, 1], [0, .5]]) * [w-1, h-1]
    destinations = np.concatenate((target - origin, border))
    displacements = np.concatenate((original - target, np.zeros_like(border)))
    try:
        mesh = Delaunay(destinations)
    except QhullError:
        return False
    # Only the displacement field is coarsened on a close-up. The actual
    # photograph is sampled once, at the full video resolution.
    nx, ny = min(w, 192), min(h, 192)
    gx, gy = np.meshgrid(np.linspace(0, w-1, nx), np.linspace(0, h-1, ny))
    grid = np.stack((gx, gy), axis=-1)
    triangles = mesh.find_simplex(grid)
    affine = mesh.transform[triangles]
    weights = np.einsum("...ij,...j->...i", affine[:, :, :2], grid - affine[:, :, 2])
    weights = np.concatenate((weights, 1 - weights.sum(axis=2, keepdims=True)), axis=2)
    flow = np.einsum("...i,...ij->...j", weights, displacements[mesh.simplices[triangles]])
    flow[triangles < 0] = 0
    flow = cv2.resize(flow.astype("float32"), (w, h), interpolation=cv2.INTER_LINEAR)
    y, x = np.mgrid[:h, :w].astype("float32")
    region = image[top:bottom, left:right]
    warped = cv2.remap(region, x+flow[:, :, 0], y+flow[:, :, 1], cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)
    # Only pixels newly visible between the lips need model-generated teeth,
    # tongue or shadow. The narrow feather hides subpixel landmark uncertainty.
    aperture = np.zeros((h, w), "uint8")
    surface = target[:12] if resting else target[12:]
    inner = np.rint((surface - origin) * 16).astype("int32")
    cv2.fillPoly(aperture, [inner], 255, lineType=cv2.LINE_AA, shift=4)
    radius = max(1, round(width*(.045 if resting else .018)))
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2*radius+1, 2*radius+1))
    aperture = cv2.dilate(aperture, kernel)
    alpha = cv2.GaussianBlur(aperture.astype("float32")/255, (0, 0), max(.65, .012*width))[:, :, None]
    paste = prediction_to_image.copy()
    paste[:, 2] -= origin
    inside = cv2.warpAffine(predicted, paste, (w, h), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)
    # When a tooth or the tongue is still visible after changing the viseme,
    # carry its fine native texture along the deformation. Suppress transfer in
    # newly exposed areas and wherever the generated structure disagrees.
    source_area = cv2.contourArea(original[12:])
    target_area = cv2.contourArea(target[12:])
    if resting:
        # Match the reference to the illumination of this frame at its border.
        ring = (cv2.dilate(aperture, np.ones((7, 7), "uint8")) > 160) & (aperture < 32)
        if np.count_nonzero(ring) >= 8:
            delta = np.median(warped[ring].astype("float32") - inside[ring], axis=0)
            inside = np.clip(inside.astype("float32") + np.clip(delta, -32, 32), 0, 255)
    elif target_area > 1 and .4 < source_area / target_area < 2.5:
        inside = restore_shared_texture(warped, inside, width)
    if texture is not None:
        textures, identity, pose = texture
        inside = textures.restore(identity, pose, inside, target-origin, width)
    composed = np.rint(warped*(1-alpha) + inside*alpha).astype("uint8")
    if np.array_equal(composed, region):
        return False
    region[:] = composed
    return True


def sealed_contour(mouth):
    """Bring corresponding lip edges together while retaining the subject's lip thickness."""
    dest = mouth.copy()
    for upper, lower, top, bottom in [(13,19,2,10), (14,18,3,9), (15,17,4,8)]:
        gap = mouth[lower] - mouth[upper]
        dest[upper] += .43*gap
        dest[lower] -= .565*gap
        dest[top] += .43*gap
        dest[bottom] -= .565*gap
    gap = mouth[18] - mouth[14]
    for k in (1,5):
        dest[k] += .24*gap
    for k in (7,11):
        dest[k] -= .32*gap
    return dest


def close_native_lips(image, mouth):
    destination = sealed_contour(mouth)
    # Borrow lip pigment just *outside* the original cavity for the narrow
    # closed seam. No teeth or tongue should be pasted into a resting mouth.
    shift = (destination[14]-mouth[14]) + (mouth[14]-mouth[3])*.32
    paste = np.float64([[1, 0, shift[0]], [0, 1, shift[1]]])
    return destination, compose_mouth(image, mouth, destination, image, paste)


class LipModel:
    # EDTalk was trained on upright FFHQ face crops.
    template = np.float32([[.37691676, .46864664], [.62285697, .46912813],
                           [.50123859, .61331904], [.39308822, .72541100], [.61150205, .72490465]]) * 256

    def __init__(self):
        self.references = {}
        self.selected = {}
        self.textures = MouthTextures()

    @staticmethod
    def session(key, name):
        options = ort.SessionOptions()
        options.intra_op_num_threads = 2
        options.inter_op_num_threads = 1
        return ort.InferenceSession(model_path(key, name), sess_options=options, providers=["CPUExecutionProvider"])

    @cached_property
    def net(self):
        return self.session("lips", "edtalk_256.onnx")

    @cached_property
    def landmarks(self):
        return self.session("mouth", "peppa_wutz.onnx")

    def aligned(self, image, row):
        mat, _ = cv2.estimateAffinePartial2D(row[4:14].reshape(5, 2), self.template, method=cv2.LMEDS)
        if mat is None:
            return None, None, None
        crop = cv2.warpAffine(image, mat, (256, 256), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)
        return mat, crop, self.contours(crop)

    @staticmethod
    def openness(points):
        width = np.linalg.norm(points[48] - points[54])
        return cv2.contourArea(points[60:68])/max(width*width, 1.)

    @staticmethod
    def pose(points):
        eyes = (points[36] + points[45])/2
        return (points[30] - eyes) / max(1., np.linalg.norm(points[36] - points[45]))

    def collect_rest(self, identity, image, row, t):
        mat, _, points = self.aligned(image, row)
        if points is None:
            return
        openness = self.openness(points)
        pose = self.pose(points)
        native = cv2.invertAffineTransform(mat)
        mouth = cv2.transform(points[None, 48:], native)[0]
        self.textures.collect(identity, image, mouth, pose)
        key = identity, int(np.clip(round(pose[0]*6), -3, 3))
        previous = self.references.get(key)
        if previous and previous[0] <= openness:
            return
        pad = np.linalg.norm(mouth[0]-mouth[6])*.25
        x, y = np.maximum(0, np.floor(mouth.min(0)-pad).astype(int))
        right, bottom = np.minimum(image.shape[1::-1], np.ceil(mouth.max(0)+pad).astype(int)+1)
        if right-x < 5 or bottom-y < 4:
            return
        # Keep only this person's native mouth, capped for long films and 4K shots.
        patch = image[y:bottom, x:right].copy()
        h, w = patch.shape[:2]
        if w > 320:
            patch = cv2.resize(patch, (320, max(1, round(h*320/w))), interpolation=cv2.INTER_AREA)
        patch_to_face = mat @ np.array([[w/patch.shape[1], 0, x], [0, h/patch.shape[0], y], [0, 0, 1]])
        if openness > .012:
            # Some shots never show fully closed lips. Close the best reference
            # once in its own native texture; a per-frame closure would track
            # the original vowels, particularly as the speaker turns their head.
            ref_mouth = cv2.transform(points[None, 48:], cv2.invertAffineTransform(patch_to_face))[0]
            closed, ok = close_native_lips(patch, ref_mouth)
            if not ok:
                return
            points = points.copy()
            points[48:] = cv2.transform(closed[None], patch_to_face)[0]
        self.references[key] = openness, t, pose, points, patch, patch_to_face

    def registered_reference(self, source, inverse, identity, t):
        pose = self.pose(source)
        references = [(key, ref) for key, ref in self.references.items() if key[0] == identity]
        if references:
            previous = self.selected.get(identity)
            def score(item):
                key, ref = item
                # Hysteresis prevents alternating textures near a pose-bin boundary.
                stable = previous and previous[0] == key and 0 <= t-previous[1] < .20
                return np.linalg.norm(pose-ref[2]) + .35*ref[0] + min(abs(t-ref[1])/400, .04) - (.12 if stable else 0.)
            key, ref = min(references, key=score)
            fixed = np.r_[27:31, 36:48]
            reg, _ = cv2.estimateAffinePartial2D(ref[3][fixed], source[fixed], method=cv2.LMEDS)
            if reg is not None and np.linalg.norm(pose-ref[2]) < .36:
                to_image = inverse @ np.vstack((reg, [0., 0., 1.]))
                dest = cv2.transform(ref[3][None, 48:], to_image)[0]
                paste = to_image @ np.vstack((ref[5], [0., 0., 1.]))
                original = cv2.transform(source[None, 48:], inverse)[0]
                dest, paste = fit_speaker_mouth(original, dest, paste, resting=True)
                return key, dest, ref[4], paste
        return None

    def rest(self, image, row, identity, t):
        mat, _, source = self.aligned(image, row)
        if source is None:
            return False
        inverse = cv2.invertAffineTransform(mat)
        native = cv2.transform(source[None, 48:], inverse)[0]
        ref = self.registered_reference(source, inverse, identity, t)
        if ref is not None:
            key, dest, patch, paste = ref
            if compose_mouth(image, native, dest, patch, paste, resting=True):
                self.selected[identity] = (key, t)
                return True
        # Never paste a reference from a substantially different pose. Use the
        # native surface in this frame if a new profile obscures the reference.
        if self.openness(source) <= .012:
            return False
        return close_native_lips(image, native)[1]

    def predict(self, crop, audio):
        face = np.ascontiguousarray(crop[:, :, ::-1].transpose(2, 0, 1)[None], dtype="float32") / 255
        output = self.net.run(None, {"source": audio, "target": face, "weight": np.array([1.], dtype="float32")})[0]
        return np.rint(np.clip(output[0].transpose(1, 2, 0)[:, :, ::-1], 0, 1)*255).astype("uint8")

    def contours(self, crop):
        data = np.ascontiguousarray(crop.transpose(2, 0, 1)[None], dtype="float32") / 255
        points = self.landmarks.run(None, {"input": data})[0].reshape(68, 3)
        if np.min(points[48:, 2]) < .40 or not np.isfinite(points).all():
            return None
        return points[:, :2] * 4

    def apply(self, image, row, audio, *, identity=None, t=0., amount=1.):
        mat, crop, source = self.aligned(image, row)
        if source is None:
            return False
        prediction = self.predict(crop, audio)
        target = self.contours(prediction)
        if target is None:
            return False
        # EDTalk can shift the whole face slightly. Register on the eyes and
        # nose so that only its audio-driven change in articulation is used.
        fixed = np.r_[27:31, 36:48]
        registration, _ = cv2.estimateAffinePartial2D(target[fixed], source[fixed], method=cv2.LMEDS)
        if registration is None:
            return False
        native = cv2.invertAffineTransform(mat)
        paste = native @ np.vstack((registration, [0., 0., 1.]))
        original = cv2.transform(source[None, 48:], native)[0]
        destination = cv2.transform(target[None, 48:], paste)[0]
        destination, paste = fit_speaker_mouth(original, destination, paste)
        if amount < 1:
            ref = self.registered_reference(source, native, identity, t)
            rest = ref[1] if ref is not None else sealed_contour(original)
            blended = np.float32(rest + amount*(destination-rest))
            # Fit the teeth/tongue image into the intermediate cavity. Shape
            # interpolation, unlike dissolving two mouths, retains one lip edge.
            cavity = destination[12:]
            if cv2.contourArea(cavity) > 1:
                correction, _ = cv2.estimateAffine2D(cavity, blended[12:], method=cv2.LMEDS)
                if correction is not None:
                    paste = correction @ np.vstack((paste, [0., 0., 1.]))
            destination = blended
        # Use the reference texture only during fully formed voiced shapes.
        texture = (self.textures, identity, self.pose(source)) if amount == 1 else None
        return compose_mouth(image, original, destination, prediction, paste, texture=texture)


def compressed_audio_window(media, left, right):
    stream = media.streams.audio[0]
    origin = float((stream.start_time or 0) * stream.time_base)
    samples = np.zeros(round((right-left)*16000), "float32")
    media.seek(int((origin+left)/stream.time_base), stream=stream)
    converter = av.AudioResampler(format="flt", layout="mono", rate=16000)
    for frame in media.decode(stream):
        if frame.pts is None:
            continue
        if float(frame.pts*frame.time_base)-origin >= right:
            break
        for piece in converter.resample(frame):
            if piece.pts is None:
                continue
            wave = piece.to_ndarray().reshape(-1)
            at = round((float(piece.pts*piece.time_base)-origin-left)*16000)
            a, b = max(at, 0), min(at+len(wave), len(samples))
            if b > a:
                samples[a:b] = wave[a-at:b-at]
    return samples


def source_speech_tails(source, cues, files, source_audio=None):
    """Allow a short release only for voiced source audio continuing across an ASR cutoff."""
    from faster_whisper.vad import get_speech_timestamps
    tails = {}
    by_start = sorted(range(len(cues)), key=lambda i: cues[i]["start"])
    with (sf.SoundFile(source_audio) if source_audio is not None else av.open(str(source))) as reader:
        if source_audio is None and not reader.streams.audio:
            return tails
        busy_until = 0.
        for pos, idx in enumerate(by_start):
            cue = cues[idx]
            end = cue["end"]
            next_start = cues[by_start[pos+1]]["start"] if pos+1 < len(by_start) else float("inf")
            overlap = busy_until > cue["start"]+.01
            busy_until = max(busy_until, end)
            limit = min(end+.25, next_start)
            if idx not in files or overlap or limit-end < .04:
                continue
            left, right = max(0., end-1.), limit+.17
            if source_audio is not None:
                rate = reader.samplerate
                reader.seek(min(len(reader), round(left*rate)))
                wave = reader.read(round((right-left)*rate), dtype="float32", always_2d=True)
                if not len(wave):
                    continue
                div = gcd(16000, rate)
                samples = resample_poly(wave.mean(axis=1), 16000//div, rate//div)
            else:
                try:
                    samples = compressed_audio_window(reader, left, right)
                except av.error.FFmpegError:
                    # Standalone callers may have a sequential-only source.
                    break
            for span in get_speech_timestamps(samples, threshold=.5, min_silence_duration_ms=100, speech_pad_ms=0):
                a, b = left+span["start"]/16000, left+span["end"]/16000
                if a < end-.04 and b > end+.025:
                    tails[idx] = min(limit, b)
    return tails


def same_face_position(a, b):
    scale = np.maximum(a[2:4], b[2:4])
    return (np.min(np.minimum(a[2:4], b[2:4])/np.maximum(scale, 1)) > .7 and
            np.linalg.norm(((a[:2]+a[2:4]/2) - (b[:2]+b[2:4]/2))/np.maximum(scale, 1)) < .5)


def nearby_articulation(samples, t, row):
    # Offline look-ahead can establish the speaker on the very first frame.
    # A nearby observation must agree on both identity and location.
    pos = bisect_left(samples, t, key=lambda entry: entry[0])
    return any(abs(at-t) <= .29 and same_face_position(box, row)
               for at, box in samples[max(0,pos-1):pos+1])


def voice_timeline(cues, files, tails=None):
    turns = [dict(cue) for cue in cues]
    for i, path in files.items():
        info = sf.info(path)
        turns[i]["end"] = max((tails or {}).get(i, turns[i]["end"]), turns[i]["start"] + info.frames/info.samplerate)
    return Timeline(turns)


def render(source: Path, mixed_audio: Path, cues: list[dict], wav_dir: Path, output: Path, *, language=None, source_audio=None) -> int:
    metadata = []
    if language:
        catalog = Path(__file__).resolve().parents[2] / "packages" / "translation-languages.json"
        iso_codes = {entry["code"]: entry["nllb"].split("_")[0] for entry in json.loads(catalog.read_text())}
        metadata = ["-metadata:s:a:0", f"language={iso_codes[language]}"]
    files = {i: wav_dir/f"{i}.wav" for i in range(len(cues)) if (wav_dir/f"{i}.wav").is_file()}
    models = FaceModels() if files else None
    lip_model = LipModel() if models else None
    anchors = SpeakerAnchors()
    prototypes, speakers = learn_speakers(source, cues, models, lip_model, anchors, source_audio) if models else ([], {})
    tails = source_speech_tails(source, cues, files, source_audio) if speakers or any(anchors.local.values()) else {}
    turns, voices, history = voice_timeline(cues, files, tails), VoiceFeatures(), MotionHistory()
    tracking, continuity = FaceTracks(), FaceContinuity()
    owners = set(speakers.values())
    last_motion, visible_turn, previous_boxes = {}, {}, {}
    changed = 0
    with TemporaryDirectory(dir=output.parent) as temp, av.open(str(source)) as src:
        stream, audio_origin, duration = video_clock(src)
        rate = stream.guessed_rate or stream.average_rate or Fraction(25, 1)
        silent = Path(temp)/"picture.mp4"
        transform, video_origin, encoder, last_report = None, None, None, -1
        frame_durations = {}
        with av.open(str(silent), "w") as dst:
            for frame in src.decode(stream):
                at = timestamp(frame, stream)
                if transform is None:
                    video_origin, transform = at, orientation(frame)
                image = oriented(frame, transform)
                t = at - audio_origin
                active = {}
                for i, cue in turns.at(t).items():
                    if i in files:
                        identity = anchors.face(i, min(t, cues[i]["end"]-.01), speakers.get(cue["speaker"]))
                        if identity is not None:
                            active[identity] = i
                original = None
                if active:
                    original = image
                    image = image.copy()
                    faces = models.detect(image)
                    ids = tracking.identify(faces, prototypes, t)
                    if len(active)==1:
                        identity, idx = next(iter(active.items()))
                        if identity not in ids.values() and idx in anchors.solo:
                            anchors.match_solo(idx, t, image, models, faces, ids, identity, owners)
                    continuity.recover(image, faces, ids, active, t, getattr(models, "describe", None), owners)
                    tracking.previous = {identity: (t, *faces[i]) for i, identity in ids.items()}
                    boxes = {identity: faces[i][0][:4] for i, identity in ids.items()}
                    for identity, box in boxes.items():
                        if identity in previous_boxes and not same_face_position(previous_boxes[identity], box):
                            history.previous.pop(identity, None)
                            last_motion.pop(identity, None)
                    previous_boxes = boxes
                    last_motion = {identity: last_motion[identity] for identity in boxes if identity in last_motion}
                    for identity, motion in history.observe(t, faces, ids).items():
                        if motion > .65:
                            last_motion[identity] = t
                    modified = voiced_edit = False
                    continuing = {}
                    for i, identity in ids.items():
                        if identity not in active:
                            continue
                        idx = active[identity]
                        # A longer translation can finish in the following
                        # pause if the same identified speaker stays visible.
                        row = faces[i][0]
                        previous = visible_turn.get(identity)
                        confirmed = previous is not None and previous[0] == idx and same_face_position(previous[1], row)
                        motion_age = t - last_motion.get(identity, -float("inf"))
                        in_source = t < cues[idx]["end"]
                        if not confirmed and not (in_source and (
                            idx in anchors.local or motion_age < .2 or nearby_articulation(anchors[idx, identity], t, row)
                        )):
                            continue
                        local_time = t-cues[idx]["start"]
                        features = voices.at(files[idx], local_time)
                        continuing[identity] = idx, row[:4].copy()
                        if features is not None:
                            amount = voices.phrase(files[idx]).articulation(local_time)
                            applied = lip_model.apply(image, row, features, identity=identity, t=t, amount=amount)
                            modified |= applied
                            voiced_edit |= applied and amount > 0
                        elif in_source or (t < tails.get(idx, 0.) and confirmed and motion_age < .2):
                            modified |= lip_model.rest(image, row, identity, t)
                    visible_turn = continuing
                    if not modified:
                        original = None
                    changed += int(voiced_edit)
                else:
                    history.previous.clear()
                    last_motion.clear()
                    visible_turn.clear()
                    previous_boxes.clear()
                    continuity.gray, continuity.observed = None, {}
                h, w = image.shape[:2]
                if encoder is None:
                    encoder = dst.add_stream("libx264", rate=rate, options={"crf": "14", "preset": "medium"})
                    encoder.width, encoder.height = w+w%2, h+h%2
                    encoder.pix_fmt = "yuv420p"
                    for field in ("color_range", "colorspace", "color_trc", "color_primaries"):
                        setattr(encoder.codec_context, field, getattr(stream.codec_context, field))
                    encoder.codec_context.time_base = Fraction(1, 90000)
                    # Preserve VFR sample durations in MP4's decode-time table.
                    encoder.codec_context.max_b_frames = 0
                    aspect = stream.sample_aspect_ratio
                    if aspect:
                        encoder.codec_context.sample_aspect_ratio = 1/aspect if round(transform[0]/90) % 2 else aspect
                out_frame = output_picture(frame, transform, image, original)
                out_frame.time_base = encoder.codec_context.time_base
                out_frame.pts = round((at-video_origin) / float(out_frame.time_base))
                if frame.duration:
                    frame_durations[out_frame.pts] = round(frame.duration * frame.time_base / out_frame.time_base)
                mux_frames(dst, encoder, frame_durations, out_frame)
                done = int(80 + 18 * np.clip((at-video_origin) / max(duration, .01), 0, 1))
                if done > last_report:
                    progress("Synchronizing translated lips", done)
                    last_report = done
            if encoder is None:
                raise ValueError("No decodable video frames")
            mux_frames(dst, encoder, frame_durations)
        # Cues and the mixed WAV are measured from the first input audio sample.
        # Preserve the original stream offset even when video and audio did not start together.
        ffmpeg("-itsoffset", max(0, video_origin-audio_origin), "-i", silent,
               "-itsoffset", max(0, audio_origin-video_origin), "-i", mixed_audio,
               "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
               "-disposition:a:0", "default+dub", "-metadata:s:a:0", "handler_name=Open EasyX Dubbed Audio",
               *metadata, "-movie_timescale", "90000", "-movflags", "+faststart", output)
    return changed
