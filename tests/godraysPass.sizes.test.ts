import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import { GODRAYS_BLUR_RESOLUTION_SCALE, BilateralFilterPass } from '../src/bilateralFilter';
import { GodraysCompositorMaterial, GodraysCompositorPass } from '../src/compositorPass';
import { GodraysPass, GodraysUpsampleQuality } from '../src/index';

/**
 * Internal fields are private, but the size invariants under test are only observable through
 * them, so cast through a structural interface instead of reaching into `any` everywhere.
 */
interface GodraysPassInternals {
  godraysRenderTarget: THREE.WebGLRenderTarget;
  blurRenderTarget: THREE.WebGLRenderTarget | null;
  blurPass: BilateralFilterPass | null;
  illumPass: {
    fullscreenMaterial: THREE.ShaderMaterial;
  };
  compositorPass: GodraysCompositorPass;
  lastAppliedWidth: number;
  lastAppliedHeight: number;
  lastAppliedResolutionScale: number;
}

const internals = (pass: GodraysPass): GodraysPassInternals =>
  pass as unknown as GodraysPassInternals;

const compositorMaterial = (pass: GodraysPass): GodraysCompositorMaterial =>
  internals(pass).compositorPass.fullscreenMaterial as GodraysCompositorMaterial;

const makeLight = (): THREE.PointLight => {
  const light = new THREE.PointLight(0xffffff, 1, 100);
  // GodraysPass requires a shadow-casting light; the shadow map texture itself is never
  // allocated because nothing is rendered in these tests.
  light.castShadow = true;
  return light;
};

const makeCamera = (): THREE.PerspectiveCamera =>
  new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 1000);

const expectedGodraysSize = (
  width: number,
  height: number,
  scale: number
): { width: number; height: number } => ({
  width: Math.ceil(width * scale),
  height: Math.ceil(height * scale),
});

const expectedBlurSize = (
  godraysWidth: number,
  godraysHeight: number
): { width: number; height: number } => ({
  width: Math.ceil(godraysWidth * GODRAYS_BLUR_RESOLUTION_SCALE),
  height: Math.ceil(godraysHeight * GODRAYS_BLUR_RESOLUTION_SCALE),
});

const assertAllSizesConsistent = (
  pass: GodraysPass,
  fullWidth: number,
  fullHeight: number,
  scale: number
): void => {
  const internal = internals(pass);
  const godrays = expectedGodraysSize(fullWidth, fullHeight, scale);
  const blur = expectedBlurSize(godrays.width, godrays.height);

  // Low-resolution godrays buffer
  assert.equal(internal.godraysRenderTarget.width, godrays.width, 'godrays RT width');
  assert.equal(internal.godraysRenderTarget.height, godrays.height, 'godrays RT height');

  // illumPass resolution uniform matches the low-resolution buffer
  const illumResolution = internal.illumPass.fullscreenMaterial.uniforms.resolution
    .value as THREE.Vector2;
  assert.equal(illumResolution.x, godrays.width, 'illumPass resolution width');
  assert.equal(illumResolution.y, godrays.height, 'illumPass resolution height');

  // Compositor full-screen resolution and godraysResolution match their respective buffers
  const mat = compositorMaterial(pass);
  const fullResolution = mat.uniforms.resolution.value as THREE.Vector2;
  const godraysResolution = mat.uniforms.godraysResolution.value as THREE.Vector2;
  assert.equal(fullResolution.x, fullWidth, 'compositor resolution width');
  assert.equal(fullResolution.y, fullHeight, 'compositor resolution height');
  assert.equal(godraysResolution.x, godrays.width, 'compositor godraysResolution width');
  assert.equal(godraysResolution.y, godrays.height, 'compositor godraysResolution height');

  // Blur pass/uniforms and its render target, when present, follow the same dimensions
  if (internal.blurPass) {
    const blurUniform = internal.blurPass.material.uniforms.resolution.value as THREE.Vector2;
    assert.equal(blurUniform.x, godrays.width, 'blur pass resolution width');
    assert.equal(blurUniform.y, godrays.height, 'blur pass resolution height');
  }
  if (internal.blurRenderTarget) {
    assert.equal(internal.blurRenderTarget.width, blur.width, 'blur RT width');
    assert.equal(internal.blurRenderTarget.height, blur.height, 'blur RT height');
  }
};

test('constructor with default params establishes consistent 1x1 buffers (default scale 0.5)', () => {
  const pass = new GodraysPass(makeLight(), makeCamera());
  const internal = internals(pass);

  // Before the composer reports a real size, the placeholder is 1x1 and every consumer of the
  // godrays resolution must agree rather than leaving any buffer at an uninitialized size.
  assertAllSizesConsistent(pass, 1, 1, 0.5);
  assert.equal(internal.lastAppliedWidth, 1);
  assert.equal(internal.lastAppliedHeight, 1);
  assert.equal(internal.lastAppliedResolutionScale, 0.5);

  pass.dispose();
});

test('constructor with explicit resolutionScale establishes consistent buffers', () => {
  const pass = new GodraysPass(makeLight(), makeCamera(), { resolutionScale: 0.25 });
  assertAllSizesConsistent(pass, 1, 1, 0.25);
  assert.equal(internals(pass).lastAppliedResolutionScale, 0.25);
  pass.dispose();
});

test('setSize after construction brings every buffer to the scaled real resolution', () => {
  for (const scale of [0.5, 0.25, 1]) {
    const pass = new GodraysPass(makeLight(), makeCamera(), { resolutionScale: scale });

    pass.setSize(1920, 1080);
    assertAllSizesConsistent(pass, 1920, 1080, scale);

    pass.setSize(800, 600);
    assertAllSizesConsistent(pass, 800, 600, scale);

    pass.dispose();
  }
});

test('repeated setSize with identical dimensions does not rebuild render targets', () => {
  const pass = new GodraysPass(makeLight(), makeCamera(), { resolutionScale: 0.5 });
  pass.setSize(1024, 768);

  const internal = internals(pass);
  const godraysTexture = internal.godraysRenderTarget.texture;
  const blurTexture = internal.blurRenderTarget?.texture;
  const godraysBefore = {
    width: internal.godraysRenderTarget.width,
    height: internal.godraysRenderTarget.height,
  };

  pass.setSize(1024, 768);
  pass.setSize(1024, 768);

  // Same target instances and dimensions: no extra allocations/rebuilds.
  assert.equal(internal.godraysRenderTarget.texture, godraysTexture, 'godrays RT reused');
  assert.equal(internal.blurRenderTarget?.texture, blurTexture, 'blur RT reused');
  assert.deepEqual(
    { width: internal.godraysRenderTarget.width, height: internal.godraysRenderTarget.height },
    godraysBefore
  );
  assertAllSizesConsistent(pass, 1024, 768, 0.5);

  pass.dispose();
});

test('changing resolutionScale at runtime immediately rebuilds at the new scale', () => {
  const pass = new GodraysPass(makeLight(), makeCamera(), { resolutionScale: 0.5 });
  pass.setSize(1024, 768);

  pass.setParams({ resolutionScale: 0.25 });
  assertAllSizesConsistent(pass, 1024, 768, 0.25);
  assert.equal(internals(pass).lastAppliedResolutionScale, 0.25);

  // Setting the same scale again must not trigger another rebuild.
  const internal = internals(pass);
  const godraysTexture = internal.godraysRenderTarget.texture;
  pass.setParams({ resolutionScale: 0.25 });
  assert.equal(internal.godraysRenderTarget.texture, godraysTexture, 'no rebuild on same scale');
  assertAllSizesConsistent(pass, 1024, 768, 0.25);

  pass.setParams({ resolutionScale: 1 });
  assertAllSizesConsistent(pass, 1024, 768, 1);

  pass.dispose();
});

test('toggling blur off and back on creates the blur target at the current size', () => {
  const pass = new GodraysPass(makeLight(), makeCamera(), {
    resolutionScale: 0.5,
    blur: true,
  });
  pass.setSize(1024, 768);
  assertAllSizesConsistent(pass, 1024, 768, 0.5);
  assert.notEqual(internals(pass).blurPass, null);
  assert.notEqual(internals(pass).blurRenderTarget, null);

  // Resize while blur is disabled; the blur resources must end up matching the new godrays size
  // when blur is re-enabled instead of keeping the stale 0.5-scale-at-1024 dimensions.
  pass.setParams({ blur: false });
  pass.setSize(800, 600);
  pass.setParams({ blur: true });

  assertAllSizesConsistent(pass, 800, 600, 0.5);
  assert.notEqual(internals(pass).blurPass, null);
  assert.notEqual(internals(pass).blurRenderTarget, null);

  const expected = expectedGodraysSize(800, 600, 0.5);
  assert.equal(internals(pass).blurRenderTarget!.width, expected.width);
  assert.equal(internals(pass).blurRenderTarget!.height, expected.height);

  pass.dispose();
});

test('blur enabled after construction without ever enabling it initially', () => {
  const pass = new GodraysPass(makeLight(), makeCamera(), {
    resolutionScale: 0.5,
    blur: false,
  });
  pass.setSize(1024, 768);
  assert.equal(internals(pass).blurPass, null);
  assert.equal(internals(pass).blurRenderTarget, null);

  pass.setParams({ blur: true });
  assertAllSizesConsistent(pass, 1024, 768, 0.5);

  pass.dispose();
});

test('full resolution (scale 1) makes godrays buffer match the screen size', () => {
  const pass = new GodraysPass(makeLight(), makeCamera(), {
    resolutionScale: 1,
    upsampleQuality: GodraysUpsampleQuality.LOW,
  });
  pass.setSize(640, 480);
  assertAllSizesConsistent(pass, 640, 480, 1);
  pass.dispose();
});
