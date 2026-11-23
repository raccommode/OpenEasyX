"""Local audiovisual confirmation for ambiguous on-screen speakers (Light-ASD, CVPR 2023)."""
from functools import cache
from math import gcd

import av
import cv2
import numpy as np
from scipy.fft import dct
from scipy.signal import resample_poly
import soundfile as sf


MODEL = "finetuning_TalkSet.model"
MODEL_URL = ("https://raw.githubusercontent.com/Junhua-Liao/Light-ASD/"
             "ed38c232de5efe0261dbd68627c0ade7cdfe14eb/weight/" + MODEL)
MODEL_SHA256 = "efc375833887eefa9d209dc92810e18519b04c3c73ea35a549f2a7f40b7d94d5"
MODEL_SIZE = 4_175_289


@cache
def mel_bank():
    frequencies = 700 * (10**(np.linspace(0, 2595*np.log10(1+8000/700), 28)/2595) - 1)
    edges = np.floor(513*frequencies/16000).astype(int)
    bins = np.arange(257)
    return np.float32([np.maximum(0, np.minimum((bins-a)/(b-a), (c-bins)/(c-b)))
                       for a, b, c in zip(edges, edges[1:], edges[2:])])


def audio_features(wave, frames):
    """The training front end uses rectangular 25 ms windows and 13 MFCCs every 10 ms."""
    x = np.asarray(wave, dtype=np.float64)*32767
    count = 4*frames
    x = np.pad(x, (0, max(0, (count-1)*160 + 400-len(x))))
    x = np.r_[x[0], x[1:]-.97*x[:-1]]
    windows = np.lib.stride_tricks.sliding_window_view(x, 400)[::160][:count]
    power = np.abs(np.fft.rfft(windows, 512, axis=1))**2 / 512
    mel = np.einsum('tf,bf->tb', power, mel_bank())
    coefs = dct(np.log(np.maximum(mel, np.finfo(float).eps)), norm='ortho', axis=1)[:, :13]
    coefs *= 1 + 11*np.sin(np.pi*np.arange(13)/22)
    coefs[:, 0] = np.log(np.maximum(power.sum(axis=1), np.finfo(float).eps))
    return coefs.astype('float32')


class ActiveSpeaker:
    """Inference architecture of Junhua Liao et al. using the authors' pinned state dict."""
    def __init__(self):
        import torch
        from model_assets import verified_asset
        weights = torch.load(verified_asset("Light-ASD", MODEL, MODEL_URL, MODEL_SIZE, MODEL_SHA256),
                             weights_only=True, map_location="cpu")
        self.layers = {}
        for name, kernel in weights.items():
            if name.endswith('.weight') and kernel.ndim in (4, 5):
                prefix, layer, _ = name.rsplit('.', 2)
                normalization = prefix + '.bn_' + layer
                factor = weights[normalization+'.weight'] / (weights[normalization+'.running_var']+.001).sqrt()
                bias = weights[normalization+'.bias'] - weights[normalization+'.running_mean']*factor
                self.layers[name[:-7]] = kernel * factor.reshape((-1,) + (1,)*(kernel.ndim-1)), bias
        self.recurrent = []
        for direction in ('forward', 'backward'):
            prefix = f'model.GRU.gru_{direction}.'
            gru = torch.nn.GRU(128, 128, batch_first=True)
            gru.load_state_dict({k[len(prefix):]: v for k, v in weights.items() if k.startswith(prefix)})
            self.recurrent.append(gru.eval())
        self.classifier = weights['lossAV.FC.weight'], weights['lossAV.FC.bias']

    def encode(self, x, *, video):
        import torch.nn.functional as F
        conv, pool = (F.conv3d, F.max_pool3d) if video else (F.conv2d, F.max_pool2d)
        encoder, spatial = ('visualEncoder', 's') if video else ('audioEncoder', 'm')
        for index in (1, 2, 3):
            prefix = f'model.{encoder}.block{index}.'
            branches = []
            for size in ('3', '5'):
                y = x
                for axis in (spatial, 't'):
                    kernel, bias = self.layers[prefix + axis + '_' + size]
                    stride = (1, 2, 2) if video and index == 1 and axis == spatial else 1
                    y = conv(y, kernel, bias, stride=stride, padding=tuple(k//2 for k in kernel.shape[2:])).relu_()
                branches.append(y)
            x = conv(branches[0] + branches[1], *self.layers[prefix+'last']).relu_()
            if index < 3:
                x = pool(x, (1, 3, 3), (1, 2, 2), (0, 1, 1)) if video else pool(x, (1, 3), (1, 2), (0, 1))
        return (x.amax(dim=(-1, -2)) if video else x.mean(dim=2)).transpose(1, 2)

    def scores(self, pictures, wave):
        import torch
        import torch.nn.functional as F
        with torch.inference_mode():
            face = torch.from_numpy(np.asarray(pictures)).float()[None, None]
            audio = torch.from_numpy(audio_features(wave, len(pictures))).T[None, None]
            joint = self.encode((face/255-.4161)/.1688, video=True) + self.encode(audio, video=False)
            for layer in self.recurrent:
                joint = F.gelu(layer(joint)[0]).flip([1])
            return F.linear(joint[0], *self.classifier).softmax(-1)[:, 1].numpy()


def track_windows(observations):
    """Bound neural memory on long takes and never interpolate through missing faces or cuts."""
    from lips import same_face_position
    group = []
    previous_vector = None
    for observation in observations:
        t, box = observation[:2]
        vector = observation[2] if len(observation)>2 else None
        appearance_cut = vector is not None and previous_vector is not None and vector @ previous_vector < .30
        if group and (appearance_cut or t-group[-1][0] > .31 or not same_face_position(group[-1][1], box) or t-group[0][0] >= 1.8):
            if len(group) >= 3:
                yield group
            group = []
        group.append((t, box))
        previous_vector = vector
    if len(group) >= 3:
        yield group


def track_scores(media, source_audio, model, observations):
    from lips import compressed_audio_window, orientation, oriented, timestamp, video_clock
    stream, origin, _ = video_clock(media)
    times = np.array([t for t, _ in observations])
    boxes = np.array([box[:4] for _, box in observations])
    left = times[0]
    sample_times = np.arange(left, times[-1]+.02, 1/25)
    media.seek(int((origin+left) / stream.time_base), stream=stream)
    pictures = []
    transform = None
    for frame in media.decode(stream):
        t = timestamp(frame, stream)-origin
        if t+.02 < sample_times[len(pictures)]:
            continue
        if transform is None:
            transform = orientation(frame)
        image = oriented(frame, transform)
        x, y, width, height = (np.interp(t, times, channel) for channel in boxes.T)
        scale = max(width,height)/2
        factor = 112 / (1.4*scale)
        mat = np.float32([[factor, 0, 56-(x+width/2)*factor], [0, factor, 56-(y+height/2+.4*scale)*factor]])
        crop = cv2.warpAffine(image, mat, (112, 112), borderMode=cv2.BORDER_CONSTANT, borderValue=(110,110,110))
        gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
        while len(pictures) < len(sample_times) and t+.02 >= sample_times[len(pictures)]:
            pictures.append(gray)
        if len(pictures) == len(sample_times):
            break
    if len(pictures) < 6:
        return []
    duration = len(pictures)/25+.025
    if isinstance(source_audio, sf.SoundFile):
        rate = source_audio.samplerate
        source_audio.seek(min(len(source_audio), max(0, round(left*rate))))
        samples = source_audio.read(round(duration*rate), dtype='float32', always_2d=True)
        if not len(samples):
            return []
        div = gcd(16000, rate)
        wave = resample_poly(samples.mean(axis=1), 16000//div, rate//div)
    else:
        wave = compressed_audio_window(source_audio, left, left+duration)
    if not len(wave) or np.max(abs(wave)) < 1e-6:
        return []
    scores = model.scores(pictures, wave)
    return [(t, float(s)) for t,s in zip(sample_times, scores)]


def speaking_face(values, assigned, speaker):
    ranked = sorted(values.items(), key=lambda item: -item[1])
    identity, score = ranked[0]
    if (assigned.get(identity, speaker) == speaker and score >= .80 and
            (len(ranked) == 1 or score > ranked[1][1]+.20)):
        return identity
    return None


def confirm_candidates(source, source_audio, candidates, motion, speakers, cues, solo):
    """Resolve an ambiguous solo turn using the source soundtrack and contemporaneous face tracks."""
    ambiguous = {}
    single_voice = len({cue["speaker"] for cue in cues}) == 1
    for idx, tracks in candidates.items():
        global_id = speakers.get(cues[idx]["speaker"])
        main_count = max(map(len, tracks.values()), default=0)
        solo_count = len(solo.get(idx, ()))
        if (global_id is None or len(tracks.get(global_id, ())) < .55*main_count or
                solo_count >= 3 and (single_voice or len(tracks.get(global_id, ())) < solo_count)):
            ambiguous[idx] = tracks
    if not ambiguous:
        return {}
    model = None
    confirmed = {}
    assigned = {face: speaker for speaker, face in speakers.items()}
    with av.open(str(source)) as media, (sf.SoundFile(source_audio) if source_audio else av.open(str(source))) as audio:
        if source_audio is None and not audio.streams.audio:
            return {}
        for idx, tracks in ambiguous.items():
            evidence = {}
            # When a single face changes pose there may be several incompatible
            # gallery entries in the same shot. Verify the physical face track
            # directly against the original audio before accepting a local alias.
            if idx in solo and sum(len(motion[idx, face]) for face in tracks) >= 2:
                available = [i for i in tracks if assigned.get(i,cues[idx]["speaker"]) == cues[idx]["speaker"]]
                identity = max(available, key=lambda i:len(tracks[i]), default=None)
                if identity is not None:
                    samples = solo[idx]
                    for group in track_windows(samples):
                        if model is None:
                            model = ActiveSpeaker()
                        for t, score in track_scores(media, audio, model, group):
                            evidence[round(t*25)] = {identity: score}
                    if evidence:
                        motion.solo[idx] = samples
                        confirmed[idx] = {frame: speaking_face(values, assigned, cues[idx]["speaker"])
                                          for frame,values in evidence.items()}
                        continue
            for face, path in tracks.items():
                if len(motion[idx, face]) < 2:
                    continue
                for group in track_windows(path):
                    if model is None:
                        model = ActiveSpeaker()
                    for t, score in track_scores(media, audio, model, group):
                        evidence.setdefault(round(t*25), {})[face] = score
            confirmed[idx] = {frame: speaking_face(values, assigned, cues[idx]["speaker"])
                              for frame, values in evidence.items()}
    return confirmed
