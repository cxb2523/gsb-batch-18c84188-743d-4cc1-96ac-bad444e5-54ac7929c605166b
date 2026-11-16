import type { FXContext, FXInstance, FXPlugin } from '../core/types';

/**
 * Long-tail parallel FX whose decay keeps sounding after the master fade has
 * closed. Their wet levels are collapsed before a style/seed transition
 * boundary so the old tail cannot bleed into the new style, and their reset()
 * is deferred past new-style instantiation so it cannot overwrite the
 * parameters the incoming style just set.
 */
export const TAIL_FX_IDS = ['reverb', 'shimmer'] as const;
const TAIL_NEAR_ZERO = 0.0001;

/** Registry + instance pool for FX plugins on the master chain. */
export class FXRegistry {
  private plugins = new Map<string, FXPlugin>();
  private instances = new Map<string, FXInstance>();

  register(plugin: FXPlugin): void {
    if (!plugin?.id || !plugin.create) throw new Error('Invalid FX plugin');
    this.plugins.set(plugin.id, plugin);
  }

  get pluginsMap(): Map<string, FXPlugin> {
    return this.plugins;
  }

  instantiateAll(makeContext: () => FXContext): void {
    for (const [id, plugin] of this.plugins) {
      if (this.instances.has(id)) continue;
      try {
        this.instances.set(id, plugin.create(makeContext()));
      } catch (err) {
        console.error(`[FXRegistry] failed to create "${id}"`, err);
      }
    }
  }

  has(id: string): boolean {
    return this.plugins.has(id);
  }

  get(id: string): FXInstance | undefined {
    return this.instances.get(id);
  }

  /** Handle usable by style plugins (setParameter only). */
  getHandle(id: string): { setParameter(name: string, value: number): void } | undefined {
    const inst = this.instances.get(id);
    if (!inst) return undefined;
    return { setParameter: (n, v) => inst.setParameter(n, v) };
  }

  /** Neutralise every FX (used when switching styles). */
  resetAll(): void {
    for (const fx of this.instances.values()) {
      try {
        fx.reset();
      } catch (err) {
        console.error('[FXRegistry] reset failed', err);
      }
    }
  }

  /**
   * Smoothly pull the wet level of the long-tail FX (reverb + shimmer) down to
   * near zero while a transition is in flight, reusing the fade time window.
   * The already-ringing tail keeps decaying acoustically, but can no longer
   * pick up new input, so nothing of the old style survives the boundary.
   * Only the FX wet parameter moves — the master fade/volume are untouched.
   */
  convergeTailWet(): void {
    for (const id of TAIL_FX_IDS) {
      const fx = this.instances.get(id);
      if (!fx) continue;
      try {
        fx.setParameter('wet', TAIL_NEAR_ZERO);
      } catch (err) {
        console.error(`[FXRegistry] tail converge failed for "${id}"`, err);
      }
    }
  }

  /**
   * Reset every FX except the long-tail ones. Used at a transition boundary:
   * the short/serial FX return to neutral before the new style arms them, while
   * reverb/shimmer keep the near-zero wet established by convergeTailWet() and
   * wait for the incoming style's own parameters (their full reset happens in
   * the teardown of a later, non-transition stop).
   */
  resetAllExceptTailFX(): void {
    const tail = new Set<string>(TAIL_FX_IDS);
    for (const [id, fx] of this.instances) {
      if (tail.has(id)) continue;
      try {
        fx.reset();
      } catch (err) {
        console.error('[FXRegistry] reset failed', err);
      }
    }
  }

  disposeAll(): void {
    for (const fx of this.instances.values()) {
      try {
        fx.dispose();
      } catch {
        /* ignore */
      }
    }
    this.instances.clear();
  }
}
