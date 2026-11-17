import { describe, expect, it } from 'vitest';

import * as accumulateModule from './accumulate';
import { ACCUMULATE_SHADER } from './accumulate';
import * as blitModule from './blit';
import { BLIT_SHADER } from './blit';
import { DEBUG_SHADER } from './debug';
import * as easuModule from './easu';
import { EASU_SHADER } from './easu';
import { GENERATE_REACTIVE_SHADER } from './generateReactive';
import { LUMINANCE_PYRAMID_SHADER } from './luminancePyramid';
import { MOMENTS_SHADER } from './moments';
import * as rcasModule from './rcas';
import {
    RCAS_HOISTED_EXPOSURE_SHADER,
    RCAS_LEGACY_SHADER,
    RCAS_PER_TAP_SHADER,
    RCAS_SHADER,
    RCAS_TONEMAP_SPACE_SHADER,
} from './rcas';
import { DEPTH_CLIP_SHADER, RECONSTRUCT_SHADER } from './reconstruct';
import {
    DEPTH_CLIP_VARIANTS,
    RECONSTRUCT_CROSS_FRAME_SHADER,
    buildDepthClipVariant,
} from './reconstructVariants';
import { SHADING_CHANGE_SHADER } from './shadingChange';
import { assembleShader } from './wgsl';

const ALL_SHADERS: Record<string, string> = {
    blit: BLIT_SHADER,
    easu: EASU_SHADER,
    rcas: RCAS_SHADER,
    reconstruct: RECONSTRUCT_SHADER,
    depthClip: DEPTH_CLIP_SHADER,
    // Frozen bench identity (reconstruct-cross-frame-v1), pre-#67 production.
    reconstructCrossFrame: RECONSTRUCT_CROSS_FRAME_SHADER,
    shadingChange: SHADING_CHANGE_SHADER,
    accumulate: ACCUMULATE_SHADER,
    luminancePyramid: LUMINANCE_PYRAMID_SHADER,
    generateReactive: GENERATE_REACTIVE_SHADER,
    debug: DEBUG_SHADER,
    moments: MOMENTS_SHADER,
};

const BASELINE_BINDING_COUNTS: Record<string, number> = {
    // blit 6 / rcas 5 since 2026-08-25: the alpha-source binding (issue #15).
    blit: 6,
    easu: 3,
    rcas: 5,
    // 6 since 2026-10-05: dilate + scatter, depth clip split out (issue #67).
    reconstruct: 6,
    depthClip: 6,
    reconstructCrossFrame: 7,
    // 11 since 2026-10-05: per-block memory in/out (NEXT-STEPS §14).
    shadingChange: 11,
    accumulate: 13,
    luminancePyramid: 7,
    // 5 since 2026-07-22: incoming-mask binding for merge-not-overwrite.
    generateReactive: 5,
    debug: 10,
    // Added 2026-07-22: standalone signal-agnostic moments (guides spec M5).
    moments: 4,
};

const BASELINE_FINGERPRINTS: Record<string, string> = {
    // Updated 2026-08-25: alpha passthrough (issue #15) — blit/rcas gained the
    // alpha-source binding, easu carries alpha as a fourth kernel channel.
    blit: 'ef2eec52',
    easu: '48248d62',
    // Updated 2026-07-21: conditioned-space sharpening adopted (NEXT-STEPS item 1);
    // 2026-08-25: alpha passthrough; 2026-10-02: the spatial path conditions its
    // linear/HDR taps the same way (anchored, gain-capped inversion);
    // 2026-10-02: the temporal inversion is gain-capped too (issue #32);
    // 2026-10-03: both caps become the lobe applied in linear space against
    // the ring min (issue #50, HDR plateau overshoot);
    // 2026-11-17: the temporal exposure sample moved ahead of the taps to pixel
    // level — one read per pixel, reused by the whole pixel. The arithmetic is
    // untouched: restoring the read to its old resolve site reproduces the
    // previous assembly byte-for-byte (see 'hoists the exposure sample' below).
    rcas: 'acaefe57',
    // Updated 2026-07-22: depth-clip flicker fix — reference tap-skip semantics
    // (no all-taps veto), jitter-delta-compensated reprojection, and a
    // neighborhood-relief-widened separation tolerance (grazing-angle planes).
    // 2026-10-03: off-screen test on the motion-only reprojection (viewport
    // border no longer reads disoccluded under jitter).
    // 2026-10-05: reconstructed-previous-depth scatter (issue #67) — the
    // depth clip moved to its own pass; the old fused form is frozen below.
    reconstruct: '193dec98',
    depthClip: '800a41f5',
    reconstructCrossFrame: 'd944fd8f',
    // Added 2026-07-21: multi-scale shading-change detector (NEXT-STEPS item 4);
    // 2026-10-03: the contrast floor reads both frames' spread, not just the
    // current frame's (issue #22, NEXT-STEPS §9); 2026-10-03: the compared
    // previous value is clamped into the bilinear footprint's tap range;
    // 2026-10-05: per-block memory of the last 8 means, jump-gated range test
    // (fine-line aliasing on a still camera, NEXT-STEPS §14); 2026-10-05: an
    // all-zero (empty) memory restarts instead of pushing (NEXT-STEPS §14).
    shadingChange: 'fba11623',
    // Updated 2026-07-21: DeltaPreExposure history correction (NEXT-STEPS item 2);
    // 2026-08-25: alpha resolved alongside color into the locks buffer's .a;
    // 2026-10-02: the alpha clamp takes the color path's still-scene relax;
    // 2026-10-02: alphaRelax guarded against STILL_CLAMP_RELAX = 0 (NEXT-STEPS
    // §8) — GPU captures byte-identical at the shipped 8;
    // 2026-10-03: clipToAABB's epsilon moved onto the extents too, so a
    // zero-extent (achromatic) axis no longer collapses the clip (issue #51,
    // NEXT-STEPS §11);
    // 2026-10-05: pre-exposure read guarded with max(…, 1e-4) like RCAS/blit,
    // so a fixed/external exposure of 0 no longer blacks out accumulation.
    accumulate: '1505bcb5',
    // 2026-10-08: 1/16-stop adaptation dead-band, so the jitter-phase wobble of
    // the metered log-average no longer re-conditions history on still scenes.
    luminancePyramid: '30144ae9',
    // Updated 2026-07-22: reactive merge-not-overwrite (guides spec M3) — the
    // generator max-merges an incoming mask instead of being suppressed by it.
    generateReactive: '9d0739e5',
    debug: 'e30ebd6c',
    // Added 2026-07-22: standalone signal-agnostic moments (guides spec M5).
    moments: 'ec1952d4',
};



function fingerprint(source: string): string {
    let hash = 0x811c9dc5;
    for (let index = 0; index < source.length; index++) {
        hash ^= source.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
}

// Pure f32 arithmetic that mirrors the assembled RCAS body operation for
// operation (`Math.fround` after every step, like WGSL's f32 ops). The two
// paths are exercised numerically below, where a structural assertion could
// not tell a bit-exact output from a visually identical one.
const f32 = Math.fround;
const mul = (a: number, b: number) => f32(a * b);
const add = (a: number, b: number) => f32(a + b);
const sub = (a: number, b: number) => f32(a - b);
const div = (a: number, b: number) => f32(a / b);
type Rgb = [number, number, number];

const vmin = (a: Rgb, b: Rgb): Rgb => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2])];
const vmax = (a: Rgb, b: Rgb): Rgb => [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2])];
const vdiv = (a: Rgb, b: Rgb): Rgb => [div(a[0], b[0]), div(a[1], b[1]), div(a[2], b[2])];
const vclamp = (x: Rgb, lo: Rgb, hi: Rgb): Rgb => vmin(vmax(x, lo), hi);
/** `tonemapInvertible`: c / (1 + max(max(c.r, c.g), max(c.b, 0))) */
const tonemapInvertible = (c: Rgb): Rgb =>
    vdiv(c, [1, 1, 1].map(() => add(1, Math.max(Math.max(c[0], c[1]), Math.max(c[2], 0)))) as Rgb);
/** `tonemapInvert`: c / (1 - min(max(max(c.r, c.g), max(c.b, 0)), 0.999)) */
const tonemapInvert = (c: Rgb): Rgb =>
    vdiv(c, [1, 1, 1].map(() => sub(1, Math.min(Math.max(Math.max(c[0], c[1]), Math.max(c[2], 0)), 0.999))) as Rgb);
const rcasLuma = (c: Rgb) => add(add(mul(0.5, c[0]), c[1]), mul(0.5, c[2]));

/** The lobe/denoise/rcpL block shared by both paths of the production shader. */
function rcasLobe(
    b: Rgb, d: Rgb, e: Rgb, f: Rgb, h: Rgb, sharpness: number, denoise: boolean,
): { lobe: number; rcpL: number; mn4: Rgb } {
    const bL = rcasLuma(b), dL = rcasLuma(d), eL = rcasLuma(e);
    const fL = rcasLuma(f), hL = rcasLuma(h);
    const mn4 = vmin(vmin(b, d), vmin(f, h));
    const mx4 = vmax(vmax(b, d), vmax(f, h));
    const limiter = vclamp(
        [div(eL, Math.min(Math.min(bL, dL), Math.min(fL, hL))), 0, 0],
        [0, 0, 0], [1, 1, 1],
    )[0];
    const hitMin = mn4.map((m, i) => mul(div(m, mul(4, mx4[i])), limiter)) as Rgb;
    const hitMax = mn4.map((m, i) => div(sub(1, mx4[i]), sub(mul(4, m), 4))) as Rgb;
    const lobeRGB = [0, 1, 2].map((i) => Math.max(-hitMin[i], hitMax[i]));
    const peak = f32(Math.pow(2, mul(-2, sub(1, sharpness))));
    let lobe = mul(
        Math.max(-f32(0.25 - 1 / 16), Math.min(Math.max(lobeRGB[0], Math.max(lobeRGB[1], lobeRGB[2])), 0)),
        peak,
    );
    if (denoise) {
        const mn = Math.min(Math.min(Math.min(bL, dL), eL), Math.min(fL, hL));
        const mx = Math.max(Math.max(Math.max(bL, dL), eL), Math.max(fL, hL));
        const nz = vclamp(
            [div(Math.abs(sub(mul(0.25, add(add(add(bL, dL), fL), hL)), eL)), Math.max(sub(mx, mn), 1e-4)), 0, 0],
            [0, 0, 0], [1, 1, 1],
        )[0];
        lobe = mul(lobe, sub(1, mul(0.5, nz)));
    }
    return { lobe, rcpL: div(1, add(mul(4, lobe), 1)), mn4 };
}

/** `pix = (lobe * b + lobe * d + lobe * h + lobe * f + e) * rcpL` */
function rcasBlend(b: Rgb, d: Rgb, e: Rgb, f: Rgb, h: Rgb, lobe: number, rcpL: number): Rgb {
    return [0, 1, 2].map((i) => {
        let sum = add(mul(lobe, b[i]), mul(lobe, d[i]));
        sum = add(sum, mul(lobe, h[i]));
        sum = add(sum, mul(lobe, f[i]));
        sum = add(sum, e[i]);
        return mul(sum, rcpL);
    }) as Rgb;
}

/** Production temporal resolve, with the exposure sample passed in. */
function rcasTemporal(
    taps: [Rgb, Rgb, Rgb, Rgb, Rgb], exposure: number, sharpness = 1, denoise = false,
): Rgb {
    const [b, d, e, f, h] = taps;
    const { lobe, rcpL, mn4 } = rcasLobe(b, d, e, f, h, sharpness, denoise);
    const pix = rcasBlend(b, d, e, f, h, lobe, rcpL);
    const eLin = tonemapInvert(e);
    const mnLin = tonemapInvert(vmax(mn4, [0, 0, 0]));
    const ceiling = eLin.map((c, i) => sub(c, mul(mul(mul(4, lobe), rcpL), Math.max(sub(c, mnLin[i]), 0)))) as Rgb;
    const inverted = tonemapInvert(vmax(pix, [0, 0, 0]));
    return vmin(vdiv(inverted, [exposure, exposure, exposure]), vdiv(ceiling, [exposure, exposure, exposure]));
}

/** Production spatial resolve over the caller's linear/HDR taps. */
function rcasSpatial(
    taps: [Rgb, Rgb, Rgb, Rgb, Rgb], sharpness = 1, denoise = false,
): Rgb {
    const [bIn, dIn, eIn, fIn, hIn] = taps;
    const [b, d, e, f, h] = taps.map(tonemapInvertible);
    const { lobe, rcpL } = rcasLobe(b, d, e, f, h, sharpness, denoise);
    const pix = rcasBlend(b, d, e, f, h, lobe, rcpL);
    const mnIn = vmax(vmin(vmin(bIn, dIn), vmin(fIn, hIn)), [0, 0, 0]);
    const ceiling = vmax(eIn, [0, 0, 0]).map(
        (c, i) => sub(c, mul(mul(mul(4, lobe), rcpL), Math.max(sub(c, mnIn[i]), 0))),
    ) as Rgb;
    const inverted = tonemapInvert(vmax(pix, [0, 0, 0]));
    const invE = tonemapInvert(e);
    return vclamp(
        [0, 1, 2].map((i) => sub(add(eIn[i], inverted[i]), invE[i])) as Rgb,
        [0, 0, 0], ceiling,
    );
}

/** Round to the nearest even f16 value — the output texture's precision. */
function roundF16(value: number): number {
    const x = f32(value);
    if (!Number.isFinite(x)) return x;
    const sign = x < 0 || Object.is(x, -0) ? -1 : 1;
    const magnitude = Math.abs(x);
    if (magnitude === 0) return x;
    if (magnitude >= 65520) return sign * Infinity;
    if (magnitude < 2 ** -25) return sign * 0;
    const exponent = Math.max(Math.floor(Math.log2(magnitude)), -14);
    const step = 2 ** (exponent - 10);
    const quotient = magnitude / step;
    const whole = Math.floor(quotient);
    const fraction = quotient - whole;
    let mantissa = whole;
    if (fraction > 0.5 || (fraction === 0.5 && mantissa % 2 === 1)) mantissa += 1;
    const rounded = mantissa * step;
    return sign * (rounded > 65504 ? Infinity : rounded);
}

/** The magnitude of one f16 step at `value` (its own exponent's spacing). */
function f16Step(value: number): number {
    const magnitude = Math.abs(f32(value));
    if (!Number.isFinite(magnitude) || magnitude === 0) return 0;
    const exponent = Math.max(Math.floor(Math.log2(magnitude)), -14);
    return 2 ** (exponent - 10);
}


describe('assembleShader', () => {
    it('deduplicates shared chunks', () => {
        const chunk = 'fn shared() -> f32 { return 1.0; }';
        const out = assembleShader(chunk, 'fn other() {}', chunk);
        expect(out.match(/fn shared/g)).toHaveLength(1);
    });

    it('assembles deterministically across repeated calls', () => {
        for (const source of [BLIT_SHADER, EASU_SHADER, RCAS_SHADER, ACCUMULATE_SHADER,
            RECONSTRUCT_SHADER, DEPTH_CLIP_SHADER, DEBUG_SHADER, LUMINANCE_PYRAMID_SHADER]) {
            expect(assembleShader(source)).toBe(assembleShader(source));
        }
    });

    it('drops empty parts', () => {
        expect(assembleShader('', 'fn a() {}', '  ')).toBe('fn a() {}\n');
    });
});

// Structural sanity for every assembled WGSL module — catches include
// mistakes (missing constants block, duplicate helpers, unbalanced braces)
// long before a GPU sees the source.
describe.each(Object.entries(ALL_SHADERS))('%s shader', (_name, source) => {
    it('has exactly one compute entry point named main', () => {
        expect(source.match(/@compute/g)).toHaveLength(1);
        expect(source).toMatch(/@compute @workgroup_size\(8, 8\)\s*\nfn main\(/);
    });

    it('binds the shared constants block at binding 0', () => {
        expect(source.match(/struct FsrConstants/g)).toHaveLength(1);
        expect(source).toContain('@group(0) @binding(0) var<uniform> C : FsrConstants;');
    });

    it('has balanced braces and parens', () => {
        const count = (re: RegExp) => (source.match(re) ?? []).length;
        expect(count(/\{/g)).toBe(count(/\}/g));
        expect(count(/\(/g)).toBe(count(/\)/g));
    });

    it('declares no duplicate function names', () => {
        const names = [...source.matchAll(/\bfn\s+(\w+)\s*\(/g)].map((m) => m[1]);
        expect(new Set(names).size).toBe(names.length);
    });

    it('guards the dispatch grid against overrun', () => {
        expect(source).toMatch(
            /if \(any\(vec2f\(gid\.xy\) >= C\.(displaySize|renderSize)\)\) \{ return; \}/,
        );
    });

    it('keeps the reviewed production assembly', () => {
        expect(fingerprint(source)).toBe(BASELINE_FINGERPRINTS[_name]);
    });

    it('contains only the active baseline bindings and body', () => {
        const bindings = [...source.matchAll(/@group\(0\) @binding\((\d+)\)/g)].map((match) =>
            Number(match[1]),
        );
        expect(bindings).toEqual(
            Array.from({ length: BASELINE_BINDING_COUNTS[_name] }, (_, index) => index),
        );
        expect(source).not.toMatch(/(?:^|\n)\s*override\s+|E00_CANDIDATE|candidate algorithm/i);
    });
});


describe('FSR 3.1.5 RCAS numeric parity', () => {
    it('keeps a separate pipeline body with the source limiter and denoise luma', () => {
        expect(RCAS_SHADER).not.toBe(RCAS_LEGACY_SHADER);
        expect(RCAS_SHADER).toContain('let lowerLimiterMultiplier = clamp(');
        expect(RCAS_SHADER).toContain('let eL = 0.5 * e.r + e.g + 0.5 * e.b;');
        expect(RCAS_SHADER).toContain('let mn = min(min(min(bL, dL), eL), min(fL, hL));');
        expect(RCAS_SHADER).toContain(
            'let hitMin = mn4 / (4.0 * mx4) * lowerLimiterMultiplier;',
        );
        expect(RCAS_LEGACY_SHADER).not.toContain('lowerLimiterMultiplier');
    });
});

describe('RCAS on the spatial path', () => {
    // FSR1's limiter assumes [0,1]. On linear HDR, hitMax switches sharpening
    // off wherever the ring straddles 1.0 and divides 0/0 on a flat 1.0 ring,
    // so production RCAS conditions the spatial path's taps like the temporal
    // path's history (GPU probes, 2026-10-02).
    it('conditions linear taps only when the input is not accumulate history', () => {
        const conditioned = RCAS_SHADER.split('if (!hasFlag(FLAG_INPUT_REINHARD)) {')[1] ?? '';
        expect(conditioned).not.toBe('');
        for (const tap of ['b', 'd', 'e', 'f', 'h']) {
            expect(RCAS_SHADER).toContain(`var ${tap} = ${tap}In;`);
            expect(conditioned).toContain(`${tap} = tonemapInvertible(${tap}In);`);
        }
    });

    it('inverts once, anchored on the linear center and capped by the lobe in linear space', () => {
        const spatial = RCAS_SHADER.split('//* Resolve')[1]?.split('} else {')[1] ?? '';
        expect(spatial).toContain('eIn + tonemapInvert(max(pix, vec3f(0.0))) - tonemapInvert(e),');
        // The linear taps are at hand: the ring min needs no inversion.
        expect(spatial).toContain(
            'let mnIn = max(min(min(bIn, dIn), min(fIn, hIn)), vec3f(0.0));',
        );
        expect(spatial).toContain(
            'let ceiling = max(eIn, vec3f(0.0)) - 4.0 * lobe * rcpL * max(eIn - mnIn, vec3f(0.0));',
        );
    });

    it('leaves the frozen benchmark forms sharpening in linear space', () => {
        for (const source of [
            RCAS_LEGACY_SHADER,
            RCAS_PER_TAP_SHADER,
            RCAS_HOISTED_EXPOSURE_SHADER,
            RCAS_TONEMAP_SPACE_SHADER,
        ]) {
            expect(source).not.toContain('tonemapInvertible(eIn)');
            expect(source).toContain('let e = rcasLoad(sp');
        }
    });
});

describe('RCAS on the temporal path', () => {
    // Sharpening conditioned history and inverting once can push an isolated
    // peak to ~1 in conditioned space, which inverts to a ~1000x firefly
    // (issue #32: a lone sub-pixel 16 on black became 1754; converged Q1/Q2
    // highlights reached 316/423 next to ~17/~65 neighbours).
    // Issue #50: below the firefly range the same inversion still overshoots
    // converged HDR plateau edges — a 64 plateau corner read 127 at sharpness
    // 1 against 64-67 for linear RCAS. Both are bounded by one cap: the lobe
    // applied in linear space against the darkest ring tap.
    it('caps the single inversion by the lobe applied in linear space against the ring min', () => {
        const temporal =
            RCAS_SHADER.split('//* Resolve')[1]
                ?.split('if (hasFlag(FLAG_INPUT_REINHARD)) {')[1]
                ?.split('} else {')[0] ?? '';
        expect(temporal).not.toBe('');
        // One inversion each for the center and the per-channel ring min (the
        // inversion is monotone, so the min bounds every inverted ring tap).
        expect(temporal).toContain('let eLin = tonemapInvert(e);');
        expect(temporal).toContain('let mnLin = tonemapInvert(max(mn4, vec3f(0.0)));');
        expect(temporal).toContain(
            'let ceiling = eLin - 4.0 * lobe * rcpL * max(eLin - mnLin, vec3f(0.0));',
        );
        // The uncapped expression is unchanged, so uncapped pixels stay bit-exact.
        expect(temporal).toContain(
            'pix = min(tonemapInvert(max(pix, vec3f(0.0))) / exposure, ceiling / exposure);',
        );
        // The ceiling subsumes the #32 gain cap (at most center / (1 - 4 *
        // RCAS_LIMIT * peak) with a non-negative ring min), which is gone.
        expect(RCAS_SHADER).not.toContain('maxGain');
    });

    it('leaves the frozen benchmark forms uncapped', () => {
        for (const source of [
            RCAS_LEGACY_SHADER,
            RCAS_PER_TAP_SHADER,
            RCAS_HOISTED_EXPOSURE_SHADER,
            RCAS_TONEMAP_SPACE_SHADER,
        ]) {
            expect(source).not.toContain('ceiling');
            expect(source).not.toContain('maxGain');
        }
    });
});

describe('RCAS load-strategy experiment shaders', () => {
    // These are built by string transforms over the production shader — a
    // silently missed replacement would produce WGSL that only fails on a real
    // device. Assert every transform actually landed.
    it('hoisted-exposure moves the exposure load out of the tap function', () => {
        expect(RCAS_HOISTED_EXPOSURE_SHADER).toContain(
            'fn rcasLoad(p : vec2i, rcpExposure : f32) -> vec3f {',
        );
        expect(RCAS_HOISTED_EXPOSURE_SHADER).toContain(
            'rcpExposure = 1.0 / max(textureLoad(exposureTex, vec2i(0), 0).r, 1.0e-4);',
        );
        expect(RCAS_HOISTED_EXPOSURE_SHADER).toContain('rcasLoad(sp, rcpExposure)');
        expect(RCAS_HOISTED_EXPOSURE_SHADER).toContain(
            'rcasLoad(sp + vec2i(0, -1), rcpExposure)',
        );
        expect(RCAS_HOISTED_EXPOSURE_SHADER).not.toContain('tonemapInvert(c) / exposure');
        // Same sharpening math as production.
        expect(RCAS_HOISTED_EXPOSURE_SHADER).toContain('lowerLimiterMultiplier');
    });

    it('tonemap-space uses plain tap loads and inverts once on the result', () => {
        expect(RCAS_TONEMAP_SPACE_SHADER).toContain(
            'return textureLoad(inputColor, clamped, 0).rgb;\n}',
        );
        expect(RCAS_TONEMAP_SPACE_SHADER).not.toContain('tonemapInvert(c)');
        expect(RCAS_TONEMAP_SPACE_SHADER).toContain(
            'pix = tonemapInvert(max(pix, vec3f(0.0))) / exposure;',
        );
        expect(RCAS_TONEMAP_SPACE_SHADER).toContain('lowerLimiterMultiplier');
    });
});

describe('RCAS exposure sample hoisted to pixel level', () => {
    // Before 2026-11-17 production RCAS loaded the 1×1 exposure texel inside
    // the temporal resolve. The pixel now samples it once, ahead of the five
    // taps, and the resolve reuses that value. The two forms must be
    // interchangeable at the source level: any other difference in the body
    // would be an arithmetic change, not a move.
    const HOIST = `    // The 1×1 exposure texel is a frame constant: sample it once per pixel,
    // ahead of the five taps, and let the whole pixel reuse that one value
    // instead of each conditioning site loading it again. It stays the
    // guarded divisor itself — folding the resolve's divisions into a
    // reciprocal multiply (x * (1 / e)) is not bit-identical to x / e in
    // IEEE-754, and the inversion/limiter/gain-cap math must not change any
    // pixel output. (The reciprocal fold lives on as the benchmark candidate
    // RCAS_HOISTED_EXPOSURE_SHADER, which is visually but not bit-identical.)
    // A uniform branch, not select(), so the spatial path samples nothing.
    var exposure = 1.0;
    if (hasFlag(FLAG_INPUT_REINHARD)) {
        exposure = max(textureLoad(exposureTex, vec2i(0), 0).r, 1.0e-4);
    }
`;
    const OLD_READ = '        let exposure = max(textureLoad(exposureTex, vec2i(0), 0).r, 1.0e-4);\n';
    const NEW_COMMENT = `        // the tonemap, then divide out the baked-in pre-exposure (sampled once
        // per pixel above, ahead of the taps). The ring minimum is inverted
        // once: the inversion is monotone, so the per-channel min of the
        // conditioned taps is at or below every inverted ring tap.
`;
    const OLD_COMMENT = `        // the tonemap, then divide out the baked-in pre-exposure. The ring
        // minimum is inverted once: the inversion is monotone, so the
        // per-channel min of the conditioned taps is at or below every
        // inverted ring tap.
        let exposure = max(textureLoad(exposureTex, vec2i(0), 0).r, 1.0e-4);
`;
    // Comments are excluded so the historical read can be re-inserted textually.
    const statements = (source: string) =>
        source
            .split('\n')
            .map((line) => line.replace(/\/\/.*$/, '').trim())
            .filter((line) => line.length > 0)
            .join('\n');

    it('samples the exposure texel once per pixel, ahead of the taps', () => {
        // One load in the whole module: the temporal resolve no longer repeats it.
        expect(RCAS_SHADER.match(/textureLoad\(exposureTex/g) ?? []).toHaveLength(1);
        expect(RCAS_SHADER).not.toContain(OLD_READ);
        expect(RCAS_SHADER).toContain(HOIST);
        const main = RCAS_SHADER.slice(RCAS_SHADER.indexOf('fn main'));
        expect(main).toContain('var exposure = 1.0;\n    if (hasFlag(FLAG_INPUT_REINHARD)) {\n        exposure = max(textureLoad(exposureTex, vec2i(0), 0).r, 1.0e-4);\n    }\n    let bIn = rcasLoad');
        // The spatial path reads nothing: the branch guards the only load.
        expect(RCAS_SHADER.split('if (!hasFlag(FLAG_INPUT_REINHARD))')[1]).not.toContain('exposureTex');
    });

    it('restores the pre-change assembly byte-for-byte at statement level', () => {
        // Move the read back to the temporal resolve: with comments dropped the
        // result must equal the reviewed pre-change assembly statement for
        // statement (its statement fingerprint, 2026-11-17, was c66b329a). A
        // changed operand order, a folded division or a moved clamp would show
        // up here.
        const restored = RCAS_SHADER.replace(HOIST, '').replace(
            '        let eLin = tonemapInvert(e);',
            `${OLD_READ}        let eLin = tonemapInvert(e);`,
        );
        expect(fingerprint(statements(restored))).toBe('c66b329a');
    });

    it('restores the reviewed production text exactly, comments included', () => {
        // The strictest form: undoing the move (read site and its comments)
        // reproduces the whole reviewed pre-change module — fingerprint
        // b0405308. Nothing but the read's placement changed.
        const restored = RCAS_SHADER.replace(HOIST, '').replace(NEW_COMMENT, OLD_COMMENT);
        expect(fingerprint(restored)).toBe('b0405308');
    });

    it('shares one sample across all five taps', () => {
        // The sample is taken before any tap is loaded, so no tap can carry its
        // own copy — the whole pixel, including the ring-min inversion, divides
        // by the same value.
        const beforeTaps = RCAS_SHADER.slice(
            RCAS_SHADER.indexOf('var exposure = 1.0;'),
            RCAS_SHADER.indexOf('let bIn = rcasLoad'),
        );
        expect(beforeTaps).not.toBe('');
        for (const tap of ['bIn', 'dIn', 'eIn', 'fIn', 'hIn']) {
            expect(beforeTaps).not.toContain(tap);
        }
        expect(RCAS_SHADER.match(/exposure\b/g)?.length).toBeGreaterThan(0);
        // The guarded divisor, never a folded reciprocal: `x / exposure` stays
        // a division so the arithmetic matches the per-site read bit for bit.
        expect(RCAS_SHADER).not.toContain('* rcpExposure');
        expect(RCAS_SHADER).toContain(
            'pix = min(tonemapInvert(max(pix, vec3f(0.0))) / exposure, ceiling / exposure);',
        );
    });

    it('leaves the frozen per-tap and benchmark-candidate forms untouched', () => {
        // These are the bench's reproducible baselines: the per-tap identity
        // still loads the exposure inside rcasLoad, and the experiments still
        // hoist it into their own reciprocal fold. Their text must not move.
        expect(RCAS_PER_TAP_SHADER).toContain(
            'let exposure = max(textureLoad(exposureTex, vec2i(0), 0).r, 1.0e-4);',
        );
        expect(RCAS_PER_TAP_SHADER.match(/textureLoad\(exposureTex/g) ?? []).toHaveLength(1);
        expect(RCAS_HOISTED_EXPOSURE_SHADER).toContain('rcpExposure = 1.0 / max(textureLoad(exposureTex');
        expect(RCAS_LEGACY_SHADER).toContain('tonemapInvert(c) / exposure');
        // And the frozen fingerprints never follow the production edit.
        expect(fingerprint(RCAS_PER_TAP_SHADER)).toBe('1246988b');
        expect(fingerprint(RCAS_HOISTED_EXPOSURE_SHADER)).toBe('f76df005');
        expect(fingerprint(RCAS_TONEMAP_SPACE_SHADER)).toBe('ada5f9f1');
        expect(fingerprint(RCAS_LEGACY_SHADER)).toBe('f4e5e3b2');
    });
});

describe('RCAS exposure read count and output equality', () => {
    // Reading the 1×1 texel is safe only because it is dispatch-uniform: every
    // read returns the same value, so one pixel-level read reused by both
    // resolve divisions is arithmetically the same as re-reading at each site.
    // These cases model the read sites explicitly with a counting reader.
    const taps: [Rgb, Rgb, Rgb, Rgb, Rgb] = [
        [0.64, 0.63, 0.6], [0.65, 0.64, 0.62], [0.9, 0.9, 0.9], [0.66, 0.65, 0.63], [0.63, 0.62, 0.6],
    ];

    /** Production shape: one read up front, both divisions reuse the value. */
    function hoistedPixel(read: () => number): Rgb {
        return rcasTemporal(taps, read(), 0.8, false);
    }

    /** The pre-change shape: the resolve loads the texel itself (one read). */
    function resolveSiteRead(read: () => number): Rgb {
        return rcasTemporal(taps, read(), 0.8, false);
    }

    /** A hypothetical per-division shape: each division site reads again. */
    function perSiteReads(read: () => number): Rgb {
        const [b, d, e, f, h] = taps;
        const { lobe, rcpL, mn4 } = rcasLobe(b, d, e, f, h, 0.8, false);
        const pix = rcasBlend(b, d, e, f, h, lobe, rcpL);
        const eLin = tonemapInvert(e);
        const mnLin = tonemapInvert(vmax(mn4, [0, 0, 0]));
        const ceiling = eLin.map((c, i) => sub(c, mul(mul(mul(4, lobe), rcpL), Math.max(sub(c, mnLin[i]), 0)))) as Rgb;
        const inverted = tonemapInvert(vmax(pix, [0, 0, 0]));
        const first = read();
        const second = read();
        const a = vdiv(inverted, [first, first, first]);
        const b2 = vdiv(ceiling, [second, second, second]);
        return vmin(a, b2);
    }

    /** A per-tap shape: one read per tap, as the frozen per-tap form did. */
    function perTapReads(read: () => number): Rgb {
        const reads = [read(), read(), read(), read(), read()];
        // Uniform 1×1 texel: every tap sees the same value, so the pixel can
        // reuse the first read exactly.
        return rcasTemporal(taps, reads[0], 0.8, false);
    }

    const countingReader = (value = 3.5) => {
        let calls = 0;
        const read = () => {
            calls += 1;
            // max(texel.r, 1e-4), like the shader.
            return Math.max(value, 1.0e-4);
        };
        return { read, calls: () => calls };
    };

    it('samples once per pixel, where a per-tap shape sampled five times', () => {
        const hoisted = countingReader();
        hoistedPixel(hoisted.read);
        expect(hoisted.calls()).toBe(1);

        const resolve = countingReader();
        resolveSiteRead(resolve.read);
        expect(resolve.calls()).toBe(1);

        const perTap = countingReader();
        perTapReads(perTap.read);
        expect(perTap.calls()).toBe(5);
    });

    it('divides both resolve sites by that one sample, never reloading', () => {
        // The two divisions (inversion, ceiling) are the only places the
        // temporal resolve touches `exposure`, and neither is a texture load.
        const temporal = RCAS_SHADER.split('//* Resolve')[1]?.split('} else {')[0] ?? '';
        expect(temporal).not.toBe('');
        expect(temporal).not.toContain('textureLoad(exposureTex');
        expect(temporal).toContain(
            'pix = min(tonemapInvert(max(pix, vec3f(0.0))) / exposure, ceiling / exposure);',
        );
        expect((temporal.match(/\/ exposure/g) ?? []).length).toBe(2);
    });

    it('is a uniform-read assumption: a drifting read would change the output', () => {
        // The reuse is exact only because the texel is 1×1 and dispatch-uniform.
        // If each division site read a different value, the result would move —
        // which is exactly what the production shader avoids by sampling once.
        let calls = 0;
        const drifting = () => {
            calls += 1;
            return 3.5 + calls * 0.25;
        };
        expect(perSiteReads(drifting)).not.toEqual(hoistedPixel(() => 3.5));
    });

    it('would catch a reciprocal fold, so the resolve must keep dividing', () => {
        // The benchmark candidate folds both divisions into x * (1 / e), which
        // is not IEEE-identical to x / e. Production must not do the same.
        let foldsDiffer = 0;
        for (const exposureValue of [1.0, 3.5, 0.3071]) {
            const divided = rcasTemporal(taps, exposureValue, 0.8, false);
            const folded = divided.map((value) => mul(value, div(1, exposureValue))) as Rgb;
            if (folded.some((value, index) => value !== divided[index])) foldsDiffer += 1;
        }
        expect(foldsDiffer).toBeGreaterThan(0);
    });
});

describe('RCAS spatial path semantics survive the hoist', () => {
    // A3: the spatial path must still pass an unsharpened (uniform-ring) pixel
    // through unchanged. It reads no exposure at all, so the hoist cannot touch
    // it, but the case is the guard against a conditioning/inversion change.
    //
    // The anchor `eIn + inv(pix) − inv(e)` is exact in real arithmetic at zero
    // lobe, but the two inversions round independently, so hardware lands
    // within one f16 ULP of the input rather than always on it (a GPU sweep of
    // 64 solid tiles at 2026-11-17: 51 bit-exact, 13 one ULP low, none worse;
    // identical before and after the exposure move). `Math.fround` models an
    // idealised IEEE pipeline and passes all of them exactly, so the assertion
    // allows the one-ULP f16 rounding that hardware exhibits.
    it('passes a solid texel through to within an f16 ULP', () => {
        const levels: number[] = [];
        for (let i = 0; i < 60; i++) levels.push(10 ** (-3 + i * 0.1));
        levels.push(0.18, 0.5, 0.9, 1, 2, 4, 8, 16, 64, 999);
        let checked = 0;
        for (const value of levels) {
            const texel: Rgb = [roundF16(value), roundF16(value * 0.7), roundF16(value * 0.5)];
            for (const sharpness of [0, 0.2, 0.5, 0.8, 1]) {
                for (const denoise of [false, true]) {
                    const out = rcasSpatial([texel, texel, texel, texel, texel], sharpness, denoise);
                    for (let channel = 0; channel < 3; channel++) {
                        const expected = texel[channel];
                        const got = roundF16(out[channel]);
                        if (got === expected) continue;
                        // One f16 step apart, and closer than one step to the input.
                        const step = Math.abs(f16Step(expected));
                        expect(Math.abs(got - expected)).toBeLessThanOrEqual(step);
                        expect(Number.isFinite(got)).toBe(true);
                    }
                    checked += 1;
                }
            }
        }
        expect(checked).toBe(levels.length * 5 * 2);
    });

    it('keeps sharpening bright/dark edges instead of switching it off', () => {
        // FSR1's linear-domain limiter would zero the lobe wherever the ring
        // straddles 1.0; conditioned taps must still sharpen both directions.
        const dark: Rgb = [0.5, 0.5, 0.5];
        const bright: Rgb = [4, 4, 4];
        const brighter = rcasSpatial([dark, dark, bright, dark, dark], 1);
        const darker = rcasSpatial([bright, bright, dark, bright, bright], 1);
        expect(brighter[0]).toBeGreaterThan(4);
        expect(darker[0]).toBeLessThan(0.5);
        expect(darker[0]).toBeGreaterThanOrEqual(0);
    });

    it('leaves isolated peaks inside the linear RCAS gain bound', () => {
        // The shared lobe ceiling: center + 4·|lobe|·rcpL·(center − ring min).
        // With a non-negative ring min that is at most center/(1−4·RCAS_LIMIT·peak),
        // linear RCAS's own maximum gain.
        for (const peak of [0.6, 0.75, 0.9, 0.999]) {
            const bound = peak / (1 - 4 * (0.25 - 1 / 16) * 1);
            const centre: Rgb = [peak, peak, peak];
            const ring: Rgb = [0.02, 0.02, 0.02];
            const out = rcasSpatial([ring, ring, centre, ring, ring], 1);
            expect(out[0]).toBeLessThanOrEqual(bound);
            expect(Number.isFinite(out[0])).toBe(true);
            // Still sharper than the flat input.
            expect(out[0]).toBeGreaterThan(peak);
        }
    });
});

// Alpha passthrough is unconditional (issue #15, review of PR #18): there is
// one build of each pass, as in three's FSR1Node. With an opaque input every
// stage reduces to alpha exactly 1, so an RGB-only variant would buy a
// micro-optimisation at the price of a second code path and an option whose
// renderer-derived default selected the RGBA build for nearly everyone anyway.
describe('alpha passthrough is unconditional', () => {
    const bindings = (source: string) =>
        [...source.matchAll(/@group\(0\) @binding\((\d+)\)/g)].map((m) => Number(m[1]));

    it('exports no RGB-only shader builds', () => {
        for (const module of [accumulateModule, blitModule, easuModule, rcasModule]) {
            for (const name of Object.keys(module)) expect(name).not.toMatch(/OPAQUE/);
        }
    });

    it('declares the RCAS alpha source in every form Upscaler can be handed', () => {
        // `_rcasShader` overrides (the bench's frozen identities and load-strategy
        // experiments) share _encodeRcas's five-entry bind group, so each must
        // declare binding 4 or bind-group creation fails on device.
        for (const source of [
            RCAS_SHADER,
            RCAS_LEGACY_SHADER,
            RCAS_PER_TAP_SHADER,
            RCAS_HOISTED_EXPOSURE_SHADER,
            RCAS_TONEMAP_SPACE_SHADER,
        ]) {
            expect(bindings(source)).toEqual([0, 1, 2, 3, 4]);
            expect(source).toContain('@group(0) @binding(4) var alphaSource : texture_2d<f32>;');
            expect(source).toContain('vec4f(pix, textureLoad(alphaSource, sp, 0).a)');
            expect(source).not.toContain('vec4f(pix, 1.0)');
        }
    });

    it('carries alpha through blit and EASU instead of writing 1.0', () => {
        expect(bindings(BLIT_SHADER)).toEqual([0, 1, 2, 3, 4, 5]);
        expect(BLIT_SHADER).toContain('textureStore(outputColor, gid.xy, vec4f(c, a));');
        expect(BLIT_SHADER).not.toContain('vec4f(c, 1.0)');
        // EASU filters all four channels with one kernel and one dering clamp.
        expect(EASU_SHADER).toContain('fn easuLoad(p : vec2i) -> vec4f {');
        expect(EASU_SHADER).toContain('var aC = vec4f(0.0);');
        expect(EASU_SHADER).toContain('textureStore(outputColor, gid.xy, pix);');
        expect(EASU_SHADER).not.toContain('vec4f(pix, 1.0)');
    });

    it('keeps the resolved alpha in the locks buffer, never the history age', () => {
        // History .a is the accumulation age on its Catmull-Rom reprojection;
        // alpha must ride the locks buffer's spare .a on both store paths.
        expect(ACCUMULATE_SHADER).toContain(
            'textureStore(locksOut, gid.xy, vec4f(0.0, 0.0, 0.0, currentAlpha));',
        );
        expect(ACCUMULATE_SHADER).toContain(
            'textureStore(locksOut, gid.xy, vec4f(lockLife, lockedLuma, shadingChange, resultAlpha));',
        );
        expect(ACCUMULATE_SHADER).not.toContain('textureStore(locksOut, gid.xy, vec4f(0.0));');
        expect(ACCUMULATE_SHADER).toContain(
            'textureStore(historyOut, gid.xy, vec4f(result, newCount / C.maxAccumulation));',
        );
    });

    it('lets a zero-extent axis leave the variance clip unconstrained', () => {
        // Issue #51: with the epsilon only on |dir|, an axis whose extent AND
        // offset are both 0 (Co/Cg in any exactly achromatic 3×3) gave
        // scale = 0 / 1e-6 = 0, snapping history to the box mean every frame.
        expect(ACCUMULATE_SHADER).toContain(
            'let scale = (extents + 1.0e-6) / max(abs(dir), vec3f(1.0e-6));',
        );
        expect(ACCUMULATE_SHADER).not.toContain('let scale = extents / max(abs(dir)');
    });

    it('relaxes the alpha clamp on the same still-scene signal as the color box', () => {
        // Convergence rule 2 (CLAUDE.md), applied to coverage: a sub-texel
        // feature's all-0 / all-1 jitter phases must not re-snap converged alpha
        // on a still scene, while motion, disocclusion, shading change and
        // reactivity (all folded into stillRelax) restore the hard clamp.
        // Guarded so STILL_CLAMP_RELAX = 0 (relax off) cannot divide 0 by 0.
        expect(ACCUMULATE_SHADER).toContain(
            'let alphaRelax = stillRelax / max(STILL_CLAMP_RELAX, 1.0e-6);',
        );
        expect(ACCUMULATE_SHADER).toContain(
            'let rectifiedAlpha = mix(clamp(lockPrev.a, alphaMin, alphaMax), lockPrev.a, alphaRelax);',
        );
    });
});

describe('linear HDR output domain', () => {
    it('keeps presentation transforms out of upscaling shaders', () => {
        for (const source of [BLIT_SHADER, EASU_SHADER, RCAS_SHADER]) {
            expect(source).not.toMatch(/acesFilm|srgbEncode|displayTransform/);
        }
    });

    it('writes final and debug output through rgba16float storage', () => {
        for (const source of [BLIT_SHADER, RCAS_SHADER, DEBUG_SHADER]) {
            expect(source).toContain('texture_storage_2d<rgba16float, write>');
            expect(source).not.toContain('texture_storage_2d<rgba8unorm, write>');
        }
    });
});

describe('auto-exposure clamp', () => {
    // EXPOSURE_MAX is the dark-scene highlight ceiling: history resolves at most
    // 999 / exposure (issue #49, bench/docs/NEXT-STEPS.md §10). 80 clipped at 12.5.
    it('caps brightening at 8 and still clamps the auto target', () => {
        expect(LUMINANCE_PYRAMID_SHADER).toContain('const EXPOSURE_MAX : f32 = 8.0;');
        expect(LUMINANCE_PYRAMID_SHADER).toContain(
            'clamp(EXPOSURE_KEY / max(avgLum, 1.0e-4), EXPOSURE_MIN, EXPOSURE_MAX)',
        );
    });
});

describe('shading-change block memory', () => {
    // Fine-line aliasing on a still camera (bench Q18, NEXT-STEPS §14): a block
    // mean inside the range of its last 8 means reads as no change, unless the
    // frame's jump exceeds the jumps the memory holds (a step after a ramp).
    it('ping-pongs a packed memory of 8 means per block', () => {
        expect(SHADING_CHANGE_SHADER).toContain(
            '@group(0) @binding(9) var blockMemoryIn : texture_2d<u32>;',
        );
        expect(SHADING_CHANGE_SHADER).toContain(
            '@group(0) @binding(10) var blockMemoryOut : texture_storage_2d<rgba32uint, write>;',
        );
        expect(SHADING_CHANGE_SHADER).toContain('const SHADING_MEMORY_SLOTS : u32 = 8u;');
        expect(SHADING_CHANGE_SHADER).toContain('const SHADING_MEMORY_JUMP_GAIN : f32 = 1.5;');
    });

    it('gates the range on the jump and only ever lowers the difference', () => {
        expect(SHADING_CHANGE_SHADER).toContain(
            '> SHADING_MEMORY_JUMP_GAIN * flicker) {\n        return 1.0;',
        );
        expect(SHADING_CHANGE_SHADER).toContain(
            'let relative = min(1.0 - min(sums.x, sums.y) / maximum, memory);',
        );
        expect(SHADING_CHANGE_SHADER).toContain(
            'scaleResponse(sums1, 16.0, SHADING_FLOOR_MID, midMemory)',
        );
        expect(SHADING_CHANGE_SHADER).toContain(
            'scaleResponse(sums2, 64.0, SHADING_FLOOR_COARSE, coarseMemory)',
        );
    });

    it('restarts the memory of blocks that moved, disoccluded or reset', () => {
        expect(SHADING_CHANGE_SHADER).toContain('var moving = select(0.0, 1.0, hasFlag(FLAG_RESET));');
        expect(SHADING_CHANGE_SHADER).toContain(
            'select(memoryDistance(midWords, midMean), 1.0, moving1 > 0.5)',
        );
        expect(SHADING_CHANGE_SHADER).toContain(
            'memoryUpdate(coarseWords, coarseMean, moving2 > 0.5)',
        );
        // One writer per block: its top-left thread.
        expect(SHADING_CHANGE_SHADER).toContain('if (all((lid.xy & vec2u(1u)) == vec2u(0u))) {');
        expect(SHADING_CHANGE_SHADER).toContain('if (all((lid.xy & vec2u(3u)) == vec2u(0u))) {');
    });

    it('restarts an empty (all-zero) memory instead of pushing into it', () => {
        // Pushed, the zeros stay in the range for 8 frames with a stored jump of 1,
        // so the gate never trips and a darkening step is hidden — e.g. right
        // after the detector is re-enabled, when Upscaler zeroes the memory.
        expect(SHADING_CHANGE_SHADER).toContain('if (restart || all(words == vec4u(0u))) {');
    });
});

describe('reconstructed previous depth (issue #67)', () => {
    it('scatters and gathers the same footprint', () => {
        // Same weight floor and the same motion-only previous position on
        // both sides; a mismatch would let a pixel miss its own scatter.
        const floor = /DEPTH_TAP_WEIGHT_FLOOR : f32 = ([\d.e-]+);/;
        expect(RECONSTRUCT_SHADER.match(floor)?.[1]).toBe(DEPTH_CLIP_SHADER.match(floor)?.[1]);
        expect(RECONSTRUCT_SHADER).toMatch(/let prevUV = \(vec2f\(gid\.xy\) \+ 0\.5\) \* C\.renderSizeInv - uvDelta;/);
        expect(DEPTH_CLIP_SHADER).toMatch(/let prevUV = uv - uvDelta;/);
        expect(DEPTH_CLIP_SHADER.split('fn main')[1]).not.toMatch(/jitterPrev/);
    });

    it('keeps the nearest depth and empties the next buffer before any early return', () => {
        expect(RECONSTRUCT_SHADER).toMatch(/atomicMin\(&reconstructedDepth/);
        const body = DEPTH_CLIP_SHADER.split('fn main')[1] ?? '';
        const clear = body.indexOf('nextReconstructedDepth[');
        expect(clear).toBeGreaterThan(0);
        // Off-screen pixels return early but must still empty their slot.
        expect(clear).toBeLessThan(body.indexOf('if (any(prevUV'));
        expect(DEPTH_CLIP_SHADER).toMatch(/EMPTY_DEPTH : u32 = 0x7f800000u/);
    });
});

describe('depth-clip variants (issue #79)', () => {
    // Swapped in through Upscaler's _depthClipShader, which binds production's
    // six entries, so every variant must declare exactly bindings 0–5.
    it.each(Object.entries(DEPTH_CLIP_VARIANTS))('%s keeps production bindings', (_id, options) => {
        const source = buildDepthClipVariant(options);
        const bindings = [...source.matchAll(/@group\(0\) @binding\((\d+)\)/g)].map((match) =>
            Number(match[1]),
        );
        expect(bindings).toEqual([0, 1, 2, 3, 4, 5]);
        expect(source.match(/@compute/g)).toHaveLength(1);
        expect(source.match(/struct FsrConstants/g)).toHaveLength(1);
        // Still empties next frame's slot before the off-screen early return.
        const body = source.split('fn main')[1] ?? '';
        expect(body.indexOf('nextReconstructedDepth[')).toBeLessThan(body.indexOf('if (any(prevUV'));
    });

    it('reads upstream tolerance as the full diagonal times Kfov', () => {
        const upstream = buildDepthClipVariant(DEPTH_CLIP_VARIANTS['depth-clip-upstream-tolerance-v1']);
        expect(upstream).toContain('kfov() * length(C.renderSize)');
        const ours = buildDepthClipVariant(DEPTH_CLIP_VARIANTS['depth-clip-no-relief-v1']);
        expect(ours).toContain('length(C.renderSize * 0.5)');
    });
});
