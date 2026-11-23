"""Fit audio-driven mouth contours to the proportions of the visible speaker."""
import numpy as np


def fit_speaker_mouth(original, target, paste, *, resting=False):
    corners = [0, 6]
    axis = original[6] - original[0]
    width = np.linalg.norm(axis)
    if width < 5:
        return target, paste
    axis = axis / width
    down = np.array([-axis[1], axis[0]])
    if (original[9] - original[3]) @ down < 0:
        down = -down
    predicted_width = (target[6] - target[0]) @ axis
    if predicted_width <= 0:
        return target, paste
    # Preserve narrow and rounded vowels. Give a closed reference more
    # leeway so its width stays stable while the source continues speaking.
    extra = max(0., predicted_width / width - 1.)
    allowance = .10 if resting else .03
    scale = (1. + allowance*np.tanh(extra/allowance))/(1. + extra)
    center = target[corners].mean(axis=0)
    drift = center - original[corners].mean(axis=0)
    lateral, vertical = drift @ axis, drift @ down
    shift = (np.clip(lateral, -.025*width, .025*width) - lateral) * axis
    shift += (np.clip(vertical, -.045*width, .045*width) - vertical) * down
    linear = np.eye(2) + (scale-1.) * np.outer(axis, axis)
    offset = center - linear @ center + shift
    fitted = np.float32(target @ linear.T + offset)
    paste = linear @ paste
    paste[:, 2] += offset
    if resting:
        return fitted, paste

    # The gap between the inner edges carries the translated vowel. Adjust
    # only the outer vermilion when the model inflates the lip tissue itself.
    for outside, inside, side in (([2,3,4], [13,14,15], -1),
                                   ([8,9,10], [17,18,19], 1)):
        thickness = side*((original[outside] - original[inside]) @ down)
        rendered = side*((fitted[outside] - fitted[inside]) @ down)
        excess = np.maximum(0., rendered - np.maximum(thickness*1.04, .012*width))
        correction = -side * excess[:, None] * down
        fitted[outside] += correction
        fitted[outside[0]-1] += .5*correction[0]
        fitted[outside[-1]+1] += .5*correction[-1]
    return fitted, paste
