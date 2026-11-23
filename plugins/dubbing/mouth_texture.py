"""Recover native high frequencies on matching oral surfaces without changing articulation."""
from collections import defaultdict
from dataclasses import dataclass
from itertools import chain

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
        self.edge_references = defaultdict(dict)
        self.previous_edge = {}
        self.byte_budget = byte_budget
        self.stored_bytes = 0

    def collect(self, identity, image, mouth, pose):
        _, width, height = mouth_basis(mouth)
        if width < 20 or height/width < .055:
            return
        self.collect_edge(identity, image, mouth, pose, width)
        patch, local = self.crop(image, mouth, width, padding=.07)
        if patch is None:
            return
        basis, opening, appearance = describe(patch, local)
        luminance = appearance.mean(2)
        # Two references of the same pose and gape can have different teeth exposed.
        key = (int(np.clip(round(pose[0]*5), -2, 2)), int(np.clip(round(opening*10), 1, 4)),
               (luminance[1:4, 3:9] > 112).mean() > .25)
        gray = cv2.cvtColor(patch, cv2.COLOR_BGR2GRAY).astype("float32")
        sharpness = np.mean(abs(gray-cv2.GaussianBlur(gray, (0, 0), 1.))) * min(1., width/100)
        ref = Reference(sharpness, pose, basis, opening, appearance, patch)
        self.retain(self.references, identity, key, ref)

    @staticmethod
    def crop(image, mouth, width, padding):
        left, top = np.maximum(0, np.floor(mouth.min(0)-padding*width).astype(int))
        right, bottom = np.minimum(image.shape[1::-1], np.ceil(mouth.max(0)+padding*width).astype(int)+1)
        if right-left < 5 or bottom-top < 4:
            return None, None
        patch = image[top:bottom, left:right]
        local = mouth - np.float32([left, top])
        if patch.shape[1] > 320:
            size = (320, max(1, round(patch.shape[0]*320/patch.shape[1])))
            local *= np.float32(size) / np.float32(patch.shape[1::-1])
            patch = cv2.resize(patch, size, interpolation=cv2.INTER_AREA)
        return patch, local

    def collect_edge(self, identity, image, mouth, pose, width):
        # Dental exposures that look alike at a distance can show different
        # tooth boundaries. Keep more detailed exposure bins for edge matching.
        patch, local = self.crop(image, mouth, width, padding=.12)
        if patch is None:
            return
        basis, opening, appearance = describe(patch, local)
        gray = cv2.cvtColor(appearance, cv2.COLOR_BGR2GRAY)
        visible = (gray[1:4, 3:9] > 100).mean()
        key = (round(pose[0]*7), round(opening*20), round(visible*5))
        native = cv2.cvtColor(patch, cv2.COLOR_BGR2GRAY).astype("float32")
        sharpness = np.mean(abs(native-cv2.GaussianBlur(native, (0, 0), 1.)))
        ref = Reference(sharpness, pose, basis, opening, appearance, patch)
        self.retain(self.edge_references, identity, key, ref)

    def retain(self, banks, identity, key, ref):
        bank = banks[identity]
        old = bank.get(key)
        if (old is not None and old.sharpness >= ref.sharpness) or ref.patch.nbytes > self.byte_budget:
            return
        if old is not None:
            self.stored_bytes -= bank.pop(key).patch.nbytes
        # Both stages share a fixed byte budget across the entire film.
        while self.stored_bytes + ref.patch.nbytes > self.byte_budget:
            largest = max(chain(self.references.values(), self.edge_references.values()), key=len)
            weakest = min(largest, key=lambda k: largest[k].sharpness)
            self.stored_bytes -= largest.pop(weakest).patch.nbytes
        ref.patch = ref.patch.copy()
        ref.pose = ref.pose.copy()
        bank[key] = ref
        self.stored_bytes += ref.patch.nbytes

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
        baseline = self.restore_surface(identity, pose, inside, target, width)
        return self.restore_enamel(identity, pose, inside, target, width, baseline)

    def restore_surface(self, identity, pose, inside, target, width):
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

    def restore_enamel(self, identity, pose, inside, target, width, baseline):
        bank = self.edge_references.get(identity)
        if not bank:
            return baseline
        basis, opening, appearance = describe(inside, target)
        candidates = []
        for key, ref in bank.items():
            angle = np.linalg.norm(pose-ref.pose)
            gap = abs(np.log(opening/ref.opening))
            if angle > .2 or gap > .75:
                continue
            delta = appearance-ref.appearance
            error = np.mean(abs(delta-np.clip(delta.mean((0, 1)), -15, 15)))
            cost = error + 13*angle + 3*gap
            if cost < 36:
                candidates.append((cost, key, ref))
        if not candidates:
            return baseline
        inner = np.zeros(inside.shape[:2], "uint8")
        cv2.fillPoly(inner, [np.rint(target[12:]).astype("int32")], 1)
        if np.count_nonzero(inner) < 35:
            return baseline
        generated = np.clip(inside, 0, 255).astype("float32")
        gray = cv2.cvtColor(generated, cv2.COLOR_BGR2GRAY)
        gx, gy = gradients(gray, width)
        magnitude = np.hypot(gx, gy)
        edge_weight = inner*np.clip(magnitude/3, 0, 1)
        best_score, best = -1., None
        for cost, key, ref in sorted(candidates, key=lambda x: x[0])[:5]:
            transform = (basis @ np.linalg.inv(ref.basis))[:2]
            aligned = align_dental_edge(ref.patch, transform, gray, width)
            donor = cv2.cvtColor(aligned, cv2.COLOR_BGR2GRAY)
            dx, dy = gradients(donor, width)
            # Verify the direction and location of the photographic edge in
            # the translated shape before borrowing any part of its contrast.
            agreement = blur(gx*dx+gy*dy, 2.8) / np.sqrt(blur(magnitude**2, 2.8)*blur(dx**2+dy**2, 2.8)+.25)
            colour_error = np.mean(abs(blur(generated, 2.5)-blur(aligned, 2.5)), axis=2)
            confidence = np.clip((agreement-.30)/.50, 0, 1)*np.clip((45-colour_error)/28, 0, 1)
            confidence *= np.clip((blur(magnitude, 1.25)-.8)/2.8, 0, 1)
            weight = (.12+confidence)*edge_weight
            score = np.sum(confidence*weight)/(np.sum(weight)+1e-8) - .004*cost
            if self.previous_edge.get(identity) == key:
                score += .035
            if score > best_score:
                best_score, best = score, (key, donor, confidence)
        if best is None:
            return baseline
        key, donor, confidence = best
        self.previous_edge[identity] = key
        previous = cv2.cvtColor(baseline.astype("float32"), cv2.COLOR_BGR2GRAY)
        sigma = np.clip(.055*width, 2.5, 8.)
        difference = (donor-blur(donor, sigma)) - (previous-blur(previous, sigma))
        change = np.clip(difference, -40, 40)*confidence*blur(inner.astype("float32"), 1.3)
        proposal = np.clip(baseline+change[:, :, None], 0, 255) - baseline
        # Change only the visible enamel edge. Preserve the previously restored
        # fine texture of the tongue and vermilion, even alongside bright teeth.
        b, g, r = cv2.split(generated)
        enamel = np.clip((gray-66)/34, 0, 1)*np.clip((1.43*g+10-r)/24, 0, 1)*np.clip((b-.55*g)/24, 0, 1)
        radius = max(1, round(.018*width))
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2*radius+1, 2*radius+1))
        enamel = blur(cv2.dilate(enamel, kernel), 1.2)
        medium_band = blur(proposal, .84)
        return np.clip(baseline+enamel[:, :, None]*(medium_band+.30*(proposal-medium_band)), 0, 255)


def blur(image, sigma):
    return cv2.GaussianBlur(image, (0, 0), sigma)


def gradients(gray, width):
    smooth = blur(gray, max(1., .012*width))
    return (cv2.Sobel(smooth, cv2.CV_32F, 1, 0, ksize=3)/8,
            cv2.Sobel(smooth, cv2.CV_32F, 0, 1, ksize=3)/8)


def align_dental_edge(patch, transform, guide, width):
    h, w = guide.shape
    native = cv2.warpAffine(patch, transform, (w, h), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)
    gray = cv2.cvtColor(native, cv2.COLOR_BGR2GRAY)
    flow = cv2.calcOpticalFlowFarneback(guide.astype("uint8"), blur(gray, 1.2), None, .5, 3, 17, 4, 5, 1.2, 0)
    flow = np.clip(flow, -.055*width, .055*width)
    y, x = np.mgrid[:h, :w].astype("float32")
    return cv2.remap(native, x+flow[:, :, 0], y+flow[:, :, 1], cv2.INTER_CUBIC,
                     borderMode=cv2.BORDER_REPLICATE).astype("float32")
