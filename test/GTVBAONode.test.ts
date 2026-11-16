import assert from "node:assert/strict";
import { Color, LinearFilter, PerspectiveCamera, RedFormat, RGBAFormat, Vector2 } from "three";
import type { ComputeNode } from "three/webgpu";
import { uniform } from "three/tsl";
import { test } from "vitest";
import GTVBAONode from "../src/GTVBAONode.js";

test("GTVBAONode variant values invalidate the shader variant", () => {
  const node = createTestGtvbaoNode();
  const material = getInternalMaterial(node);
  let invalidations = 0;
  node.setVariantChangeCallback(() => {
    invalidations += 1;
  });

  const initialNodeVersion = node.version;
  const initialMaterialVersion = material.version;
  node.stepCount.value = 12;

  assert.equal(node.stepCount.value, 12);
  assert.equal(invalidations, 1);
  assert.equal(node.version, initialNodeVersion + 1);
  assert.equal(material.version, initialMaterialVersion + 1);

  node.stepCount.value = 12;
  node.radius.value = 4;

  assert.equal(invalidations, 1);

  // expFactor and aoIntensity are uniforms with a build-time fast path at
  // their defaults; only crossing that boundary rebuilds the shader.
  node.expFactor.value = 3;

  assert.equal(invalidations, 2);
  assert.equal(node.version, initialNodeVersion + 2);
  assert.equal(material.version, initialMaterialVersion + 2);

  node.expFactor.value = 4;

  assert.equal(invalidations, 2);

  node.expFactor.value = 2;

  assert.equal(invalidations, 3);

  node.aoIntensity.value = 2;

  assert.equal(invalidations, 4);

  node.aoIntensity.value = 3;

  assert.equal(invalidations, 4);

  node.aoIntensity.value = 1;

  assert.equal(invalidations, 5);
  assert.equal(node.version, initialNodeVersion + 5);
  assert.equal(material.version, initialMaterialVersion + 5);

  node.batchVariantChanges(() => {
    node.stepCount.value = 10;
    node.usePerspectiveCorrectSlice.value = false;
  });

  assert.equal(invalidations, 6);
  assert.equal(node.version, initialNodeVersion + 6);
  assert.equal(material.version, initialMaterialVersion + 6);

  // Raw AO debug only switches the render target; the shader is unchanged.
  const versionBeforeRawDebug = node.version;
  const materialVersionBeforeRawDebug = material.version;
  node.debugMode.value = 1;

  assert.equal(node.debugMode.value, 1);
  assert.equal(invalidations, 7);
  assert.equal(node.version, versionBeforeRawDebug);
  assert.equal(material.version, materialVersionBeforeRawDebug);

  node.debugMode.value = 5;

  assert.equal(invalidations, 8);
  assert.equal(node.version, initialNodeVersion + 7);
  assert.equal(material.version, initialMaterialVersion + 7);

  node.debugMode.value = 4;

  assert.equal(invalidations, 9);
  assert.equal(node.version, initialNodeVersion + 8);

  // Out-of-range values clamp to the variant limits.
  node.sliceCount.value = 99;
  node.debugMode.value = -1;

  assert.equal(node.sliceCount.value, 8);
  assert.equal(node.debugMode.value, 0);
  assert.equal(invalidations, 11);
  assert.equal(node.version, initialNodeVersion + 10);
  assert.equal(material.version, initialMaterialVersion + 10);

  node.dispose();
});

test("GTVBAONode selects a material built for the new variant on sector measure changes after setup", () => {
  const node = createTestGtvbaoNode();
  const internals = node as unknown as { _fragmentContext: object | null; _refreshMaterialFragmentNode(): void };
  // Simulate a post-setup() state, where each variant gets its own material.
  internals._fragmentContext = {};
  internals._refreshMaterialFragmentNode();
  const cosineMaterial = getInternalMaterial(node);
  const cosineVersion = cosineMaterial.version;
  const fragmentRefreshes = installMaterialFragmentRefreshProbe(node);

  node.sectorMeasure.value = "angle";

  assert.deepEqual(fragmentRefreshes.consume(), ["angle"]);
  const angleMaterial = getInternalMaterial(node);
  assert.notEqual(angleMaterial, cosineMaterial);

  node.sectorMeasure.value = "cosine";
  assert.equal(getInternalMaterial(node), cosineMaterial);
  assert.equal(cosineMaterial.version, cosineVersion);
  // Unknown values fall back to the cosine measure.
  (node.sectorMeasure as { value: unknown }).value = "bogus";
  assert.equal(node.sectorMeasure.value, "cosine");

  node.dispose();
});

test("GTVBAONode bumps the placeholder material version on variant changes before setup", () => {
  const node = createTestGtvbaoNode();
  const material = getInternalMaterial(node);
  const version = material.version;

  node.sectorMeasure.value = "angle";

  assert.equal(getInternalMaterial(node), material);
  assert.equal(material.version, version + 1);

  node.dispose();
});

test("GTVBAONode only upsamples by depth at reduced resolution with depth MIPs", () => {
  const node = createTestGtvbaoNode();

  assert.equal(node.useDepthAwareUpsample, true);
  assert.equal(node.isDepthAwareUpsampleActive(), false);
  node.resolutionScale = 0.5;
  assert.equal(node.isDepthAwareUpsampleActive(), true);
  node.useDepthMips.value = false;
  assert.equal(node.isDepthAwareUpsampleActive(), false);
  node.useDepthMips.value = true;
  node.useDepthAwareUpsample = false;
  assert.equal(node.isDepthAwareUpsampleActive(), false);

  node.dispose();
});

test("GTVBAONode latches both upsample uniforms from the depth-aware upsample predicates", () => {
  const cases = [
    { label: "active", options: { upsampleJitter: 2 }, scale: 0.5, active: true, jitterActive: true, enabled: 1, jitter: 2, level0: [160, 90] },
    { label: "zero jitter keeps the upsample but not the jitter", options: {}, scale: 0.5, active: true, jitterActive: false, enabled: 1, jitter: 0, level0: [160, 90] },
    { label: "temporal filtering off keeps the upsample but not the jitter", options: { upsampleJitter: 2, useTemporalFiltering: false }, scale: 0.5, active: true, jitterActive: false, enabled: 1, jitter: 0, level0: [160, 90] },
    { label: "depth MIPs off", options: { upsampleJitter: 2, useDepthMips: false }, scale: 0.5, active: false, jitterActive: false, enabled: 0, jitter: 0, level0: [1, 1] },
    { label: "full resolution", options: { upsampleJitter: 2 }, scale: 1, active: false, jitterActive: false, enabled: 0, jitter: 0, level0: [320, 180] },
  ];
  for (const { label, options, scale, active, jitterActive, enabled, jitter, level0 } of cases) {
    const node = new GTVBAONode(uniform(1) as never, null, new PerspectiveCamera(), { resolutionScale: scale, ...options });
    const internals = node as unknown as { _upsampleEnabled: { value: number }; _upsampleJitter: { value: number } };

    assert.equal(node.isDepthAwareUpsampleActive(), active, label);
    assert.equal(node.isUpsampleJitterActive(), jitterActive, label);

    // Stale uniform values from a previous quality tier must not survive the frame.
    internals._upsampleEnabled.value = 99;
    internals._upsampleJitter.value = 99;
    runUpdateBefore(node, createFakeRenderer(), 0);

    assert.equal(internals._upsampleEnabled.value, enabled, label);
    assert.equal(internals._upsampleJitter.value, jitter, label);
    assert.deepEqual(depthMipLevel0Size(node), level0, label);

    node.dispose();
  }
});

test("GTVBAONode computes the depth MIP chain before enabling the upsample and releases it on fallback", () => {
  const node = new GTVBAONode(uniform(1) as never, null, new PerspectiveCamera(), { upsampleJitter: 2 });
  const internals = node as unknown as {
    _depthPrefilter: { compute(renderer: unknown): void };
    _upsampleEnabled: { value: number };
    _upsampleJitter: { value: number };
  };
  const renderer = createFakeRenderer();
  // Probe the prefilter: at compute time the chain must already be allocated at
  // the current AO size while the upsample uniforms still hold last frame's values.
  const computeStates: { enabled: number; level0: number[] }[] = [];
  const originalCompute = internals._depthPrefilter.compute.bind(internals._depthPrefilter);
  internals._depthPrefilter.compute = (rendererArg: unknown) => {
    computeStates.push({ enabled: internals._upsampleEnabled.value, level0: depthMipLevel0Size(node) });
    originalCompute(rendererArg);
  };

  // Full resolution with depth MIPs off: bilinear fallback, no MIP chain.
  node.useDepthMips.value = false;
  runUpdateBefore(node, renderer, 0);
  assert.equal(internals._upsampleEnabled.value, 0);
  assert.equal(internals._upsampleJitter.value, 0);
  assert.deepEqual(depthMipLevel0Size(node), [1, 1]);
  assert.equal(computeStates.length, 0);

  // Turning depth MIPs on and dropping below full resolution allocates and
  // computes the chain before the uniforms enable the upsample in the same frame.
  node.useDepthMips.value = true;
  node.resolutionScale = 0.5;
  runUpdateBefore(node, renderer, 1);
  assert.deepEqual(computeStates, [{ enabled: 0, level0: [160, 90] }]);
  assert.equal(internals._upsampleEnabled.value, 1);
  assert.equal(internals._upsampleJitter.value, 2);
  assert.deepEqual(depthMipLevel0Size(node), [160, 90]);

  // Back to full resolution: the upsample is off in the same frame, while the
  // chain stays allocated at the new AO size for the AO shader itself.
  node.resolutionScale = 1;
  runUpdateBefore(node, renderer, 2);
  assert.deepEqual(computeStates[1], { enabled: 1, level0: [320, 180] });
  assert.equal(internals._upsampleEnabled.value, 0);
  assert.equal(internals._upsampleJitter.value, 0);

  // Dropping below full resolution again finds the chain already allocated.
  node.resolutionScale = 0.5;
  runUpdateBefore(node, renderer, 3);
  assert.deepEqual(computeStates[2], { enabled: 0, level0: [160, 90] });
  assert.equal(internals._upsampleEnabled.value, 1);
  assert.equal(internals._upsampleJitter.value, 2);

  // Turning depth MIPs off releases the chain and falls back to bilinear in the
  // same frame; nothing reads the released textures afterwards.
  node.useDepthMips.value = false;
  runUpdateBefore(node, renderer, 4);
  assert.equal(computeStates.length, 3);
  assert.equal(internals._upsampleEnabled.value, 0);
  assert.equal(internals._upsampleJitter.value, 0);
  assert.deepEqual(depthMipLevel0Size(node), [1, 1]);

  node.dispose();
});

test("GTVBAONode switches compact AO and debug render targets", () => {
  const node = createTestGtvbaoNode();
  const internals = getGtvbaoRenderTargetInternals(node);

  assert.equal(internals._aoRenderTarget.texture.format, RedFormat);
  assert.equal(internals._debugRenderTarget.texture.format, RGBAFormat);
  assert.equal(internals._aoRenderTarget.texture.minFilter, LinearFilter);
  assert.equal(internals._aoRenderTarget.texture.magFilter, LinearFilter);

  node.resolutionScale = 0.5;
  node.setSize(320, 180);

  assert.equal(internals._aoRenderTarget.width, 160);
  assert.equal(internals._aoRenderTarget.height, 90);
  assert.equal(internals._debugRenderTarget.width, 1);
  assert.equal(internals._debugRenderTarget.height, 1);

  node.debugMode.value = 2;
  node.setSize(320, 180);

  assert.equal(internals._debugRenderTarget.width, 160);
  assert.equal(internals._debugRenderTarget.height, 90);
  assert.equal(internals._aoRenderTarget.width, 1);
  assert.equal(internals._aoRenderTarget.height, 1);

  node.debugMode.value = 0;
  node.setSize(640, 360);

  assert.equal(internals._aoRenderTarget.width, 320);
  assert.equal(internals._aoRenderTarget.height, 180);
  assert.equal(internals._debugRenderTarget.width, 1);
  assert.equal(internals._debugRenderTarget.height, 1);

  node.dispose();
});

test("GTVBAONode releases depth kernels on depth-mode changes and disposal", () => {
  const node = createTestGtvbaoNode();
  const { _depthPrefilter: prefilter } = node as unknown as {
    _depthPrefilter: {
      compute(renderer: { compute(kernels: ComputeNode[]): void }): void;
      setLogarithmicDepthBuffer(value: boolean): void;
    };
  };
  const liveKernels = new Set<ComputeNode>();
  const renderer = {
    compute(kernels: ComputeNode[]) {
      for (const kernel of kernels) {
        if (liveKernels.has(kernel)) continue;
        liveKernels.add(kernel);
        kernel.addEventListener("dispose", () => liveKernels.delete(kernel));
      }
    },
  };
  node.setSize(64, 32);
  prefilter.compute(renderer);
  assert.equal(liveKernels.size, 2);

  prefilter.setLogarithmicDepthBuffer(false);
  assert.equal(liveKernels.size, 2);

  prefilter.setLogarithmicDepthBuffer(true);
  assert.equal(liveKernels.size, 0);

  prefilter.compute(renderer);
  assert.equal(liveKernels.size, 2);

  node.dispose();
  assert.equal(liveKernels.size, 0);
});

function createTestGtvbaoNode() {
  return new GTVBAONode(uniform(1) as never, null, new PerspectiveCamera());
}

function runUpdateBefore(node: GTVBAONode, renderer: unknown, frameId: number) {
  (node as unknown as { updateBefore(frame: unknown): void }).updateBefore({ frameId, renderer });
}

function depthMipLevel0Size(node: GTVBAONode) {
  const { image } = (node.getDepthMipNodes()[0] as unknown as { value: { image: { width: number; height: number } } }).value;
  return [image.width, image.height];
}

function createFakeRenderer() {
  let renderTarget: unknown = null;
  return {
    autoClear: true,
    outputColorSpace: "",
    toneMapping: 0,
    toneMappingExposure: 1,
    compute: () => {},
    getActiveCubeFace: () => 0,
    getActiveMipmapLevel: () => 0,
    getClearAlpha: () => 1,
    getClearColor: (target = new Color()) => target.set(0),
    getDrawingBufferSize: (target: Vector2) => target.set(320, 180),
    getMRT: () => null,
    getPixelRatio: () => 1,
    getRenderObjectFunction: () => null,
    getRenderTarget: () => renderTarget,
    getScissorTest: () => false,
    render: () => {},
    setClearColor: () => {},
    setMRT: () => {},
    setPixelRatio: () => {},
    setRenderObjectFunction: () => {},
    setRenderTarget: (target: unknown) => {
      renderTarget = target;
    },
    setScissorTest: () => {},
  };
}

function getInternalMaterial(node: GTVBAONode) {
  return (node as unknown as { _material: { version: number } })._material;
}

function installMaterialFragmentRefreshProbe(node: GTVBAONode) {
  const internals = node as unknown as { _refreshMaterialFragmentNode(): void };
  const refreshes: string[] = [];
  const original = internals._refreshMaterialFragmentNode.bind(node);
  internals._refreshMaterialFragmentNode = () => {
    refreshes.push(node.sectorMeasure.value);
    original();
  };
  return {
    consume() {
      const current = [...refreshes];
      refreshes.length = 0;
      return current;
    },
  };
}

function getGtvbaoRenderTargetInternals(node: GTVBAONode) {
  return node as unknown as {
    _aoRenderTarget: {
      height: number;
      texture: { format: number; magFilter: number; minFilter: number };
      width: number;
    };
    _debugRenderTarget: {
      height: number;
      texture: { format: number };
      width: number;
    };
  };
}
