"""Recover native high frequencies on matching oral surfaces without changing articulation."""
from collections import defaultdict
from dataclasses import dataclass

import cv2
import numpy as np


def mouth_basis(points):
    horizontal = points[6] - points[0]
    width = max(1., np.linalg.norm(horizontal))
    down = np.float32([-horizontal[1], horizontal[0]]) / width
    upper = points[13:16].mean(0)
    lower = points[17:20].mean(0)
    height = max(2., (lower-upper) @ down)
    center = (upper+lower) / 2
    basis = np.vstack((np.column_stack((horizontal, down*height, center)), [0., 0., 1.]))
    return basis, width, height


def describe(image, mouth):
    basis, width, height = mouth_basis(mouth)
    # Compare tooth exposure, tongue colour and shading at corresponding points.
    standard = np.float64([[48., 0., 24.], [0., 14., 9.], [0., 0., 1.]])
    transform = (standard @ np.linalg.inv(basis))[:2]
    rectified = cv2.warpAffine(image, transform, (49, 19), borderMode=cv2.BORDER_REPLICATE)
    appearance = cv2.resize(cv2.GaussianBlur(rectified, (5, 5), 1.1), (12, 5), interpolation=cv2.INTER_AREA)
    return basis, height/width, appearance.astype("float32")


@dataclass
class Reference:
    sharpness: float
    pose: np.ndarray
    basis: np.ndarray
    opening: float
    appearance: np.ndarray
    patch: np.ndarray


class MouthTextures:
    def __init__(self, byte_budget=32*1024*1024):
        self.references = defaultdict(dict)
        self.previous = {}
        self.byte_budget = byte_budget
        self.stored_bytes = 0

    def collect(self, identity, image, mouth, pose):
        _, width, height = mouth_basis(mouth)
        if width < 20 or height/width < .055:
            return
        left, top = np.maximum(0, np.floor(mouth.min(0)-.07*width).astype(int))
        right, bottom = np.minimum(image.shape[1::-1], np.ceil(mouth.max(0)+.07*width).astype(int)+1)
        if right-left < 5 or bottom-top < 4:
            return
        patch = image[top:bottom, left:right]
        local = mouth - np.float32([left, top])
        if patch.shape[1] > 320:
            size = (320, max(1, round(patch.shape[0]*320/patch.shape[1])))
            local *= np.float32(size) / np.float32(patch.shape[1::-1])
            patch = cv2.resize(patch, size, interpolation=cv2.INTER_AREA)
        basis, opening, appearance = describe(patch, local)
        luminance = appearance.mean(2)
        # Two references of the same pose and gape can have different teeth exposed.
        key = (int(np.clip(round(pose[0]*5), -2, 2)), int(np.clip(round(opening*10), 1, 4)),
               (luminance[1:4, 3:9] > 112).mean() > .25)
        gray = cv2.cvtColor(patch, cv2.COLOR_BGR2GRAY).astype("float32")
        sharpness = np.mean(abs(gray-cv2.GaussianBlur(gray, (0, 0), 1.))) * min(1., width/100)
        bank = self.references[identity]
        old = bank.get(key)
        if (old is not None and old.sharpness >= sharpness) or patch.nbytes > self.byte_budget:
            return
        if old is not None:
            self.stored_bytes -= bank.pop(key).patch.nbytes
        # Samples are collected across the whole film. Evict from the most
        # represented identity first so subsequent speakers can contribute.
        while self.stored_bytes + patch.nbytes > self.byte_budget:
            largest = max(self.references.values(), key=len)
            weakest = min(largest, key=lambda k: largest[k].sharpness)
            self.stored_bytes -= largest.pop(weakest).patch.nbytes
        bank[key] = Reference(sharpness, pose.copy(), basis, opening, appearance, patch.copy())
        self.stored_bytes += patch.nbytes

    def choose(self, identity, pose, inside, target):
        references = self.references.get(identity)
        if not references:
            return None
        basis, opening, appearance = describe(inside, target)
        best, best_score = None, 28.
        for key, ref in references.items():
            angle = np.linalg.norm(ref.pose-pose)
            gap = abs(np.log(ref.opening/opening))
            if angle > .24 or gap > .65:
                continue
            delta = appearance-ref.appearance
            error = np.mean(abs(delta - np.clip(delta.mean((0, 1)), -12, 12)))
            score = error + 20*angle + 9*gap - (2 if self.previous.get(identity) == key else 0)
            if score < best_score:
                best, best_score = (key, ref), score
        if best is None:
            return None
        key, ref = best
        self.previous[identity] = key
        return ref.patch, (basis @ np.linalg.inv(ref.basis))[:2]

    def restore(self, identity, pose, inside, target, width):
        match = self.choose(identity, pose, inside, target)
        if match is None:
            return inside
        patch, transform = match
        h, w = inside.shape[:2]
        native = cv2.warpAffine(patch, transform, (w, h), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)
        # The translated viseme controls exposed teeth and tongue boundaries.
        # Follow those boundaries before transferring the reference's fine bands.
        gray = cv2.cvtColor(native, cv2.COLOR_BGR2GRAY)
        guide = cv2.cvtColor(inside.astype("uint8"), cv2.COLOR_BGR2GRAY)
        flow = cv2.calcOpticalFlowFarneback(guide, cv2.GaussianBlur(gray, (0, 0), 1.), None, .5, 2, 15, 3, 5, 1.2, 0)
        bound = max(2., .04*width)
        flow = np.clip(flow, -bound, bound)
        y, x = np.mgrid[:h, :w].astype("float32")
        native = cv2.remap(native, x+flow[:, :, 0], y+flow[:, :, 1], cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)
        native = native.astype("float32")
        generated = inside.astype("float32")
        sigma = np.clip(.031*width, 1.5, 4.5)
        low_native = cv2.GaussianBlur(native, (0, 0), sigma)
        low_generated = cv2.GaussianBlur(generated, (0, 0), sigma)
        # Keep the generated colour and suppress the transfer entirely where
        # the reference shows a different material, such as enamel behind a lip.
        error = np.mean(abs(low_native-low_generated), axis=2)
        weight = np.clip((48-error)/28, 0, 1)
        detail = (native-low_native) - (generated-low_generated)
        return np.clip(generated + weight[:, :, None]*np.clip(detail, -32, 32), 0, 255)
