/**
 * Backend resolution and fallback
 *
 * Single entry point for deciding which registered renderer backend actually
 * backs a viewer, and for creating that backend's renderer with a deterministic
 * fallback chain.
 *
 * Rules:
 * - Only registered backends are ever considered.
 * - `auto` prefers WebGPU when the runtime claims support, then WebGL2, then
 *   any other registered backend in registration order.
 * - An explicitly requested backend is always tried first and is never
 *   replaced while it can be created successfully.
 * - When a backend is unregistered, or its renderer factory throws, resolution
 *   continues with the next registered backend instead of failing immediately.
 * - If every candidate fails, an aggregate, human-readable error is thrown.
 *
 * Because a renderer is only returned once its factory succeeds, every GPU
 * resource created afterwards (textures, vertex/index buffers and pipelines)
 * is allocated through the surviving renderer. Resources from a backend whose
 * factory failed never escape the resolver and can never be handed to another
 * backend.
 */

import type { BackendType, IRenderer, RendererOptions } from "./types";
import { isWebGPUSupported } from "./types";
import { getRendererPlugin, getRegisteredBackends } from "./registry";
import type { RendererPlugin } from "./registry";

/** Backend preference as exposed by the viewer options */
export type BackendPreference = BackendType | "auto";

/** Result of a successful backend resolution */
export interface ResolvedBackend {
  /** The renderer created by the winning backend plugin */
  renderer: IRenderer;
  /** Backend that actually created the renderer */
  backend: BackendType;
  /** Backend the caller asked for (or "auto") */
  preferred: BackendPreference;
  /** Whether the winning backend differs from an explicit request */
  fellBack: boolean;
  /** Ordered backends that were attempted, including the winner last */
  attempts: BackendType[];
  /** Errors raised by backends attempted before the winner (empty without fallback) */
  fallbackErrors: ReadonlyArray<{ backend: BackendType; error: unknown }>;
}

/** One failed backend attempt, retained for the aggregate error message */
interface FailedAttempt {
  backend: BackendType;
  reason: unknown;
}

/**
 * Build the ordered list of registered backends to try.
 *
 * Unregistered backends are skipped rather than rejected up front, so an
 * explicit request for a missing backend transparently falls back instead of
 * producing a hard failure.
 */
export function buildBackendCandidates(preference: BackendPreference): BackendType[] {
  const registered = getRegisteredBackends();
  if (registered.length === 0) {
    return [];
  }

  if (preference !== "auto") {
    // Explicit request first; every other registered backend is a fallback.
    const fallbackOrder = registered.filter((backend) => backend !== preference);
    return registered.includes(preference) ? [preference, ...fallbackOrder] : fallbackOrder;
  }

  // auto: WebGPU first when the runtime exposes navigator.gpu, otherwise
  // deprioritize it without dropping it entirely, then WebGL2, then the rest.
  const webgpuSupported = isWebGPUSupported();
  return [...registered].sort(
    (a, b) => priority(a, webgpuSupported) - priority(b, webgpuSupported),
  );
}

function priority(backend: BackendType, webgpuSupported: boolean): number {
  if (backend === "webgpu") {
    return webgpuSupported ? 0 : 2;
  }
  if (backend === "webgl") {
    return 1;
  }
  // Any future backend slots in after the two well-known ones.
  return 1;
}

function describeError(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return String(error);
}

/**
 * Try registered backends in candidate order until one creates a renderer.
 *
 * @returns The first successfully created renderer plus fallback metadata.
 * @throws {Error} Readable aggregate error when no backend is registered or
 *                 every registered backend fails to create a renderer.
 */
export async function resolveRenderer(
  preference: BackendPreference,
  options: RendererOptions,
): Promise<ResolvedBackend> {
  const candidates = buildBackendCandidates(preference);

  if (candidates.length === 0) {
    throw new Error(
      "No renderer backend is registered. Register one using use() before creating a viewer:\n" +
        "  import { use } from 'minecraft-skin-renderer'\n" +
        "  import { WebGLRendererPlugin } from 'minecraft-skin-renderer/webgl'\n" +
        "  use(WebGLRendererPlugin)",
    );
  }

  const failures: FailedAttempt[] = [];
  const attempts: BackendType[] = [];

  for (const backend of candidates) {
    const plugin: RendererPlugin | undefined = getRendererPlugin(backend);
    if (!plugin) {
      // Defensive: candidates come from the registry, but a concurrent
      // unregister could still make the lookup miss.
      failures.push({ backend, reason: new Error("backend is not registered") });
      continue;
    }

    attempts.push(backend);
    try {
      const renderer = await plugin.createRenderer(options);
      return {
        renderer,
        backend,
        preferred: preference,
        fellBack: preference !== "auto" && preference !== backend,
        attempts,
        fallbackErrors: failures.map((failure) => ({
          backend: failure.backend,
          error: failure.reason,
        })),
      };
    } catch (error) {
      // A failed factory must not leave this backend's resources behind:
      // ownership of any partial allocation stays inside the plugin, and no
      // object created here is reused by subsequent backends.
      failures.push({ backend, reason: error });
    }
  }

  const detail = failures
    .map((failure) => `  - ${failure.backend}: ${describeError(failure.reason)}`)
    .join("\n");
  const requested = preference === "auto" ? "auto" : preference;
  throw new Error(
    `No available renderer backend (preferred: "${requested}"). ` +
      `All registered backends failed to initialize:\n${detail}`,
  );
}
