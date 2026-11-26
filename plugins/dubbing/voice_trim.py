"""Recover complete short cloned takes with an unwanted spoken prefix or suffix."""
import re
import unicodedata

import numpy as np
from scipy.ndimage import uniform_filter1d


def tokens(text):
    text = unicodedata.normalize("NFKC", text).casefold()
    # Whisper can group Japanese and Chinese characters differently in its
    # timestamps. Match the characters while retaining each acoustic word.
    text = re.sub(r"([\u3040-\u30ff\u3400-\u9fff])", r" \1 ", text)
    return re.findall(r"[^\W_]+", text)


def quiet_boundary(envelope, rate, before, after):
    # Word timestamps locate the gap approximately. Require a real quiet
    # interval between two audible words before touching the waveform.
    left = max(0, round(before.end*rate))
    right = min(len(envelope), round(after.start*rate))
    margin = max(1, round(.012*rate))
    if right-left < 4*margin:
        return None
    a = envelope[max(0, round(before.start*rate)):left]
    b = envelope[right:min(len(envelope), round(after.end*rate))]
    if not len(a) or not len(b):
        return None
    floor = min(np.quantile(a, .85), np.quantile(b, .85))
    if floor <= 1e-12:
        return None
    gap = envelope[left+margin:right-margin]
    cut = left+margin+int(np.argmin(gap))
    return cut if envelope[cut] <= .10*floor else None


def trim_verified_take(recognizer, wave, rate, language, text):
    from speech_review import at16
    from voices import verifies_words

    wave = np.asarray(wave, dtype="float32")
    wanted = tokens(text)
    # Long lines go directly to the normal retry. Only short takes can be
    # checked for a complete bounded phrase at a useful cost.
    if wave.ndim != 1 or not rate or not 0.3*rate <= len(wave) <= 6*rate or not 1 <= len(wanted) <= 12:
        return None
    audio = at16(wave, rate)
    peak = float(np.max(np.abs(audio)))
    if peak < 1e-5:
        return None
    segments, _ = recognizer.transcribe(audio*(.65/peak), language=language, beam_size=3, temperature=0.,
                                         word_timestamps=True, condition_on_previous_text=False, max_new_tokens=64)
    heard, owners = [], []
    for segment in segments:
        if segment.avg_logprob <= -1.4 or segment.no_speech_prob >= .8:
            # Do not concatenate lexical matches across an uncertain phrase.
            if tokens(segment.text):
                return None
            continue
        for word in segment.words or []:
            units = tokens(word.word)
            if units and (not 0 <= word.start < word.end <= len(wave)/rate+.04 or word.probability < .35):
                return None
            heard.extend(units)
            owners.extend([word]*len(units))
    if not 1 <= len(heard)-len(wanted) <= 4:
        return None
    found = [i for i in range(len(heard)-len(wanted)+1) if heard[i:i+len(wanted)] == wanted]
    if len(found) != 1:
        return None
    first, last = found[0], found[0]+len(wanted)
    words = owners[first:last]
    if (first and owners[first-1] is words[0]) or (last < len(heard) and owners[last] is words[-1]):
        return None
    if min(w.probability for w in words) < .5 or np.mean([w.probability for w in words]) < .7:
        return None

    envelope = uniform_filter1d(wave*wave, size=max(1, round(rate*.025)), mode="nearest")
    start = 0
    if first:
        start = quiet_boundary(envelope, rate, owners[first-1], words[0])
    end = len(wave)
    if last < len(heard):
        end = quiet_boundary(envelope, rate, words[-1], owners[last])
    if start is None or end is None or end-start < .18*rate:
        return None
    result = wave[start:end].copy()
    fade = np.linspace(0., 1., max(1, round(rate*.008)), dtype="float32")
    if start:
        result[:len(fade)] *= fade
    if end != len(wave):
        result[-len(fade):] *= fade[::-1]
    return result if verifies_words(recognizer, result, rate, language, text) else None
