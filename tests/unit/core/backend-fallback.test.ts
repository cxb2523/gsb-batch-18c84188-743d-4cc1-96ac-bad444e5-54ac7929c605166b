/**
 * Backend availability resolution and creation-failure fallback tests.
 *
 * Covers:
 * - normal fallback when an explicitly requested backend is unregistered or
 *   its renderer factory throws
 * - readable errors when no backend is registered or every backend fails
 * - auto ordering (WebGPU first, then WebGL2)
 * - resource isolation across the fallback boundary
 * - pixel ratio / canvas size consistency after fallback and resize
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSkinViewer } from "@/viewer/SkinViewer";
import { clearRendererRegistry, use } from "@/core/renderer/registry";
import { buildBackendCandidates, resolveRenderer } from "@/core/renderer/backend-resolver";
import { BufferUsage } from "@/core/renderer/types";
import type {
  BackendType,
  DrawParams,
  IBuffer,
  IPipeline,
  IRenderer,
  ITexture,
  PipelineConfig,
  RendererOptions,
} from "@/core/renderer/types";

class MockBuffer implements IBuffer {
  readonly dispose = vi.fn();
  readonly update = vi.fn();

  constructor(
    readonly id: number,
    readonly backend: BackendType,
    readonly usage: BufferUsage,
    readonly size: number,
  ) {}
}

class MockPipeline implements IPipeline {
  readonly dispose = vi.fn();

  constructor(
    readonly id: number,
    readonly backend: BackendType,
  ) {}
}

class MockTexture implements ITexture {
  readonly width = 64;
  readonly height = 64;
  readonly update = vi.fn();
  readonly dispose = vi.fn();

  constructor(
    readonly id: number,
    readonly backend: BackendType,
  ) {}
}

interface CreatedRenderer {
  renderer: MockRenderer;
  backend: BackendType;
}

class MockRenderer implements IRenderer {
  readonly drawCalls: DrawParams[] = [];
  readonly dispose = vi.fn();
  readonly beginFrame = vi.fn();
  readonly clear = vi.fn();
  readonly endFrame = vi.fn();
  width: number;
  height: number;

  private nextResourceId = 1;

  constructor(
    readonly backend: BackendType,
    readonly canvas: HTMLCanvasElement,
    readonly pixelRatio: number,
  ) {
    this.width = canvas.width;
    this.height = canvas.height;
  }

  createBuffer(usage: BufferUsage, data: ArrayBufferView): IBuffer {
    return new MockBuffer(this.nextResourceId++, this.backend, usage, data.byteLength);
  }

  async createTexture(): Promise<ITexture> {
    return new MockTexture(this.nextResourceId++, this.backend);
  }

  createPipeline(_config: PipelineConfig): IPipeline {
    return new MockPipeline(this.nextResourceId++, this.backend);
  }

  draw(params: DrawParams): void {
    this.drawCalls.push(params);
  }

  resize(width: number, height: number): void {
    this.width = Math.floor(width * this.pixelRatio);
    this.height = Math.floor(height * this.pixelRatio);
    this.canvas.width = this.width;
    this.canvas.height = this.height;
  }
}

interface MockPluginOptions {
  fail?: Error | false;
  pixelRatio?: number;
}

function registerMockPlugin(
  backend: BackendType,
  options: MockPluginOptions = {},
  created: CreatedRenderer[],
): void {
  use({
    type: "renderer",
    backend,
    createRenderer: (rendererOptions: RendererOptions) => {
      if (options.fail) {
        return Promise.reject(options.fail);
      }
      const pixelRatio = options.pixelRatio ?? rendererOptions.pixelRatio ?? 1;
      const renderer = new MockRenderer(backend, rendererOptions.canvas, pixelRatio);
      created.push({ renderer, backend });
      return renderer;
    },
    shaders: {
      vertex: "void main() {}",
      fragment: "void main() {}",
    },
  });
}

let created: CreatedRenderer[];

beforeEach(() => {
  clearRendererRegistry();
  created = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("buildBackendCandidates", () => {
  it("puts the explicit preference first and keeps other backends as fallbacks", () => {
    registerMockPlugin("webgpu", {}, created);
    registerMockPlugin("webgl", {}, created);

    expect(buildBackendCandidates("webgl")).toEqual(["webgl", "webgpu"]);
    expect(buildBackendCandidates("webgpu")).toEqual(["webgpu", "webgl"]);
  });

  it("skips an unregistered explicit preference and only lists registered backends", () => {
    registerMockPlugin("webgl", {}, created);

    expect(buildBackendCandidates("webgpu")).toEqual(["webgl"]);
  });

  it("returns an empty list when nothing is registered", () => {
    expect(buildBackendCandidates("auto")).toEqual([]);
    expect(buildBackendCandidates("webgl")).toEqual([]);
  });

  it("prefers WebGPU in auto mode when navigator.gpu exists", () => {
    vi.stubGlobal("navigator", { gpu: {} });
    registerMockPlugin("webgl", {}, created);
    registerMockPlugin("webgpu", {}, created);

    expect(buildBackendCandidates("auto")).toEqual(["webgpu", "webgl"]);
  });

  it("prefers WebGL2 in auto mode when WebGPU is unsupported", () => {
    registerMockPlugin("webgpu", {}, created);
    registerMockPlugin("webgl", {}, created);

    expect(buildBackendCandidates("auto")).toEqual(["webgl", "webgpu"]);
  });
});

describe("resolveRenderer fallback chain", () => {
  it("keeps the explicitly requested backend when it creates successfully", async () => {
    registerMockPlugin("webgl", {}, created);
    registerMockPlugin("webgpu", {}, created);
    const canvas = document.createElement("canvas");

    const result = await resolveRenderer("webgl", { canvas });

    expect(result.backend).toBe("webgl");
    expect(result.fellBack).toBe(false);
    expect(result.attempts).toEqual(["webgl"]);
    expect(result.fallbackErrors).toEqual([]);
    expect(created.map((entry) => entry.backend)).toEqual(["webgl"]);
  });

  it("falls back when the explicit backend is not registered", async () => {
    registerMockPlugin("webgl", {}, created);
    const canvas = document.createElement("canvas");

    const result = await resolveRenderer("webgpu", { canvas });

    expect(result.backend).toBe("webgl");
    expect(result.fellBack).toBe(true);
    expect(result.attempts).toEqual(["webgl"]);
    expect(created.map((entry) => entry.backend)).toEqual(["webgl"]);
  });

  it("falls back to another registered backend when creation throws", async () => {
    registerMockPlugin("webgpu", { fail: new Error("no gpu adapter") }, created);
    registerMockPlugin("webgl", {}, created);
    const canvas = document.createElement("canvas");

    const result = await resolveRenderer("webgpu", { canvas });

    expect(result.backend).toBe("webgl");
    expect(result.fellBack).toBe(true);
    expect(result.attempts).toEqual(["webgpu", "webgl"]);
    expect(result.fallbackErrors).toHaveLength(1);
    expect(result.fallbackErrors[0]!.backend).toBe("webgpu");
    expect(created.map((entry) => entry.backend)).toEqual(["webgl"]);
  });

  it("tries every registered backend in auto order and uses the first success", async () => {
    vi.stubGlobal("navigator", { gpu: {} });
    registerMockPlugin("webgpu", { fail: new Error("device lost") }, created);
    registerMockPlugin("webgl", {}, created);
    const canvas = document.createElement("canvas");

    const result = await resolveRenderer("auto", { canvas });

    expect(result.backend).toBe("webgl");
    expect(result.fellBack).toBe(false);
    expect(result.attempts).toEqual(["webgpu", "webgl"]);
  });

  it("throws a readable aggregate error when every backend fails", async () => {
    registerMockPlugin("webgpu", { fail: new Error("adapter unavailable") }, created);
    registerMockPlugin("webgl", { fail: new Error("webgl2 context null") }, created);
    const canvas = document.createElement("canvas");

    let error: unknown;
    try {
      await resolveRenderer("auto", { canvas });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain("No available renderer backend");
    expect(message).toContain("adapter unavailable");
    expect(message).toContain("webgl2 context null");
    expect(created).toHaveLength(0);
  });

  it("throws a readable error when no backend is registered", async () => {
    const canvas = document.createElement("canvas");

    await expect(resolveRenderer("auto", { canvas })).rejects.toThrow(
      /No renderer backend is registered/,
    );
  });
});

describe("SkinViewer backend fallback", () => {
  it("falls back from a failing explicit backend and reports the effective backend", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    registerMockPlugin("webgpu", { fail: new Error("no gpu adapter") }, created);
    registerMockPlugin("webgl", {}, created);

    const viewer = await createSkinViewer({
      canvas: document.createElement("canvas"),
      preferredBackend: "webgpu",
    });

    expect(viewer.backend).toBe("webgl");
    expect(created).toHaveLength(1);
    expect(created[0]!.backend).toBe("webgl");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]!.join(" ")).toContain("webgl");

    viewer.dispose();
  });

  it("does not replace an explicit backend that works", async () => {
    registerMockPlugin("webgl", {}, created);
    registerMockPlugin("webgpu", {}, created);

    const viewer = await createSkinViewer({
      canvas: document.createElement("canvas"),
      preferredBackend: "webgl",
    });

    expect(viewer.backend).toBe("webgl");
    expect(created.map((entry) => entry.backend)).toEqual(["webgl"]);

    viewer.dispose();
  });

  it("rejects with a readable error when both backends are unavailable", async () => {
    registerMockPlugin("webgpu", { fail: new Error("adapter unavailable") }, created);
    registerMockPlugin("webgl", { fail: new Error("context creation failed") }, created);

    let error: unknown;
    try {
      await createSkinViewer({
        canvas: document.createElement("canvas"),
        preferredBackend: "auto",
      });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain("No available renderer backend");
    expect(message).toContain("adapter unavailable");
    expect(message).toContain("context creation failed");
    expect(created).toHaveLength(0);
  });

  it("keeps textures, buffers and pipelines bound to the fallback backend", async () => {
    registerMockPlugin("webgpu", { fail: new Error("no gpu adapter") }, created);
    registerMockPlugin("webgl", {}, created);

    const viewer = await createSkinViewer({
      canvas: document.createElement("canvas"),
      preferredBackend: "webgpu",
    });
    viewer.render();

    const fallback = created[0]!.renderer;
    expect(fallback.backend).toBe("webgl");

    // Every draw call must use resources created by the surviving renderer:
    // the failed WebGPU factory produced no resources at all.
    expect(created).toHaveLength(1);
    for (const call of fallback.drawCalls) {
      expect(call.pipeline).toBeInstanceOf(MockPipeline);
      expect((call.pipeline as MockPipeline).backend).toBe("webgl");
      for (const buffer of call.vertexBuffers) {
        expect((buffer as MockBuffer).backend).toBe("webgl");
      }
      expect((call.indexBuffer as MockBuffer).backend).toBe("webgl");
      for (const texture of Object.values(call.bindGroup.textures)) {
        expect((texture as MockTexture).backend).toBe("webgl");
      }
    }

    viewer.dispose();
    // The fallback renderer (and only it) is disposed with the viewer.
    expect(fallback.dispose).toHaveBeenCalledTimes(1);
  });

  it("applies pixel ratio and keeps resize dimensions consistent after fallback", async () => {
    registerMockPlugin("webgpu", { fail: new Error("no gpu adapter") }, created);
    registerMockPlugin("webgl", { pixelRatio: 2 }, created);

    const canvas = document.createElement("canvas");
    const viewer = await createSkinViewer({
      canvas,
      preferredBackend: "webgpu",
      pixelRatio: 2,
    });

    const fallback = created[0]!.renderer;
    expect(viewer.backend).toBe("webgl");
    expect(fallback.pixelRatio).toBe(2);

    // Initial sizing happens through the fallback renderer's resize().
    const initialWidth = 300;
    const initialHeight = 150;
    expect(fallback.width).toBe(Math.floor(initialWidth * 2));
    expect(fallback.height).toBe(Math.floor(initialHeight * 2));
    expect(canvas.width).toBe(fallback.width);
    expect(canvas.height).toBe(fallback.height);

    // A later resize must produce the same pixel-ratio-scaled canvas size.
    viewer.resize(400, 200);
    expect(fallback.width).toBe(800);
    expect(fallback.height).toBe(400);
    expect(canvas.width).toBe(800);
    expect(canvas.height).toBe(400);

    viewer.dispose();
  });
});
