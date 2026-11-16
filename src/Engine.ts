import {
  ERROR_INVALID_LAYER,
  ERROR_INVALID_LAYER_ARRAY,
  ERROR_INVALID_ONSTEP_CALLBACK,
  ERROR_INVALID_TARGET,
  VALID_TARGET_TYPES,
} from "./constants/index.js";
import type { StepParams } from "./types.js";

import { Layer } from "./Layer.js";
import { getElement } from "./utils/index.js";

export type EngineOptions = {
  target?: string | HTMLCanvasElement;
  layers?: Layer[];
  onStep?: (params: StepParams) => void;
  autoStart?: boolean;
  autoResize?: boolean;
};

export const DEFAULT_ENGINE_OPTIONS: EngineOptions = {
  layers: [],
  onStep: null,
  autoStart: false,
  autoResize: true,
};

/**
 * A redraw waiting for the sources of a fixed set of layers.
 *
 * The ticket draws once, as soon as none of its layers is still loading.
 * Layers that leave the stack are pruned while waiting: if some are left the
 * ticket still renders for them, while a ticket with nothing left is dropped
 * so a late source resolution cannot repaint the canvas for a removed layer.
 *
 * `requiresLayer` tells a ticket for an empty stack - which still has to
 * render once, e.g. to clear the canvas - apart from a ticket whose layers
 * were all removed.
 */
type DrawTicket = {
  layers: Layer[];
  requiresLayer: boolean;
  cancelled: boolean;
};

type EngineState = Omit<EngineOptions, "autoStart" | "target"> & {
  target?: HTMLCanvasElement;
  context?: CanvasRenderingContext2D;
  isRunning: boolean;
  initialTime?: number;
  lastCallTime?: number;
};

export class Engine {
  #state: EngineState = {
    target: null,
    context: null,
    isRunning: false,
    initialTime: null,
    lastCallTime: null,
    layers: [],
    onStep: null,
    autoResize: true,
  };

  /** Redraws waiting for layer sources to settle. */
  #tickets = new Set<DrawTicket>();

  /** Layers whose source settlement is already being tracked. */
  #watched = new WeakSet<Layer>();

  /** Layers whose source promise has settled (resolved or rejected). */
  #settled = new WeakSet<Layer>();

  constructor(options: EngineOptions) {
    const { target, layers, onStep, autoStart, autoResize } = {
      ...DEFAULT_ENGINE_OPTIONS,
      ...options,
    };

    this.autoResize = autoResize;
    this.onStep = onStep;
    this.#setLayers(layers, false);
    this.target = target;

    // The first render waits until every source in the stack has settled. A
    // rejected source counts as settled, so a broken image can neither block
    // nor break the initial draw.
    if (autoStart)
      this.#whenLayersSettled(this.layers).then((): void => this.start());
    else this.#requestDraw(this.layers);
  }

  get target(): HTMLCanvasElement {
    return this.#state.target;
  }

  set target(selector: string | HTMLCanvasElement) {
    if (!selector) return;

    const { element } = getElement(selector, VALID_TARGET_TYPES);

    if (!element) throw new Error(ERROR_INVALID_TARGET);

    this.#state.target = element as HTMLCanvasElement;
    this.#state.context = this.#state.target.getContext("2d");

    if (this.autoResize) this.#resetTargetSize();
  }

  get layers() {
    return [...this.#state.layers];
  }

  set layers(newLayers: Layer[]) {
    this.#setLayers(newLayers, true);
  }

  #setLayers(newLayers: Layer[], shouldDraw: boolean) {
    if (!Array.isArray(newLayers)) throw new Error(ERROR_INVALID_LAYER_ARRAY);

    // The stack is being replaced wholesale, so any draw still waiting on the
    // previous layers is obsolete.
    this.#cancelTickets();

    const layers: Layer[] = [];

    newLayers.forEach((layer) => {
      if (layer instanceof Layer) layers.push(layer);
      else console.warn(ERROR_INVALID_LAYER);
    });

    this.#state.layers = layers;

    if (shouldDraw) this.#requestDraw(layers);
  }

  #hasLayer(layer: Layer) {
    return this.#state.layers.some((item) => Object.is(item, layer));
  }

  #isPending(layer: Layer) {
    // `source` being set already means the layer is ready, even if this engine
    // only started watching it after its promise had settled.
    return !!layer.sourcePromise && !layer.source && !this.#settled.has(layer);
  }

  /**
   * Tracks a layer's source settlement so pending draws can be re-evaluated.
   * Both outcomes are handled: a rejected source simply leaves the layer with
   * no `source` (skipped by `draw`) instead of stalling the engine or
   * producing an unhandled rejection.
   */
  #watch(layer: Layer) {
    const { sourcePromise } = layer;

    if (!sourcePromise || this.#watched.has(layer)) return;

    this.#watched.add(layer);

    const settle = () => {
      this.#settled.add(layer);
      this.#refreshTickets();
    };

    sourcePromise.then(settle, settle);
  }

  #whenLayersSettled(layers: Layer[]): Promise<void> {
    const waits = layers.map((layer) => layer.sourcePromise).filter(Boolean);

    return Promise.allSettled(waits).then((): void => undefined);
  }

  #cancelTickets() {
    this.#tickets.forEach((ticket) => {
      ticket.cancelled = true;
    });

    this.#tickets.clear();
  }

  #requestDraw(layers: Layer[]) {
    const ticket: DrawTicket = {
      layers: [...layers],
      requiresLayer: layers.length > 0,
      cancelled: false,
    };

    layers.forEach((layer) => this.#watch(layer));

    this.#tickets.add(ticket);

    // Ready layers draw asynchronously, mirroring the promise-based timing of
    // the original implementation. If a layer is still loading the ticket
    // stays queued until its source settles.
    queueMicrotask(() => this.#refreshTickets());
  }

  /**
   * Removes and reports every ticket that has nothing left to wait for.
   * Tickets whose layers all left the stack are dropped without reporting a
   * draw, so a stale source can never repaint the canvas.
   */
  #collectReadyTickets() {
    if (!this.#tickets.size) return false;

    let ready = false;

    this.#tickets.forEach((ticket) => {
      if (ticket.cancelled) {
        this.#tickets.delete(ticket);
        return;
      }

      if (ticket.requiresLayer) {
        // Drop layers that left the stack while the ticket was waiting.
        ticket.layers = ticket.layers.filter((layer) => this.#hasLayer(layer));

        if (!ticket.layers.length) {
          ticket.cancelled = true;
          this.#tickets.delete(ticket);
          return;
        }
      }

      if (ticket.layers.some((layer) => this.#isPending(layer))) return;

      ticket.cancelled = true;
      this.#tickets.delete(ticket);
      ready = true;
    });

    return ready;
  }

  /**
   * Draws when a ticket's layers become ready. While the engine is running the
   * next frame already paints the whole stack, so tickets are left pending and
   * settle on the next frame (or in `stop`), avoiding duplicate renders.
   */
  #refreshTickets() {
    if (!this.#tickets.size || this.isRunning) return;
    if (!this.#collectReadyTickets()) return;

    this.draw();
  }

  addLayer(layer: Layer, shouldDraw = true) {
    if (!(layer instanceof Layer)) {
      console.warn(ERROR_INVALID_LAYER);
      return;
    }

    this.#state.layers = [...this.layers, layer];

    if (shouldDraw) this.#requestDraw([layer]);
  }

  removeLayer(layer: Layer, shouldDraw = true) {
    this.#state.layers = this.layers.filter((item) => !Object.is(item, layer));

    // A source resolving after its layer left the stack must not schedule a
    // draw for it anymore.
    if (!this.#hasLayer(layer)) this.#pruneTickets(layer);

    // While stopped, the removal itself decides whether to repaint: exactly
    // once, and only when `shouldDraw` allows it. While running, the next
    // frame renders the updated stack, so no extra draw is added here.
    if (shouldDraw && !this.isRunning) this.draw();
  }

  /**
   * Forgets a removed layer in every pending draw. A ticket that only waited
   * for this layer is dropped, while the remaining layers of a shared ticket
   * are left untouched.
   */
  #pruneTickets(layer: Layer) {
    this.#tickets.forEach((ticket) => {
      if (!ticket.requiresLayer) return;

      const remaining = ticket.layers.filter((item) => !Object.is(item, layer));

      if (remaining.length === ticket.layers.length) return;

      ticket.layers = remaining;

      if (!remaining.length) {
        ticket.cancelled = true;
        this.#tickets.delete(ticket);
      }
    });
  }

  #resetTargetSize = () => {
    if (!this.target) return;

    this.target.width = this.target.clientWidth;
    this.target.height = this.target.clientHeight;

    this.draw();
  };

  get autoResize() {
    return this.#state.autoResize;
  }

  set autoResize(value) {
    const autoResize = !!value;

    if (autoResize && !this.autoResize)
      window.addEventListener("resize", this.#resetTargetSize);
    if (!autoResize && this.autoResize)
      window.removeEventListener("resize", this.#resetTargetSize);

    this.#state.autoResize = autoResize;
  }

  get onStep() {
    return this.#state.onStep;
  }

  set onStep(handler) {
    if (handler && typeof handler !== "function")
      throw new Error(ERROR_INVALID_ONSTEP_CALLBACK);

    this.#state.onStep = handler;
  }

  get isRunning() {
    return this.#state.isRunning;
  }

  start() {
    const now = performance.now();

    this.#state.isRunning = true;
    this.#state.initialTime = now;
    this.#state.lastCallTime = now;

    this.#step(now);
  }

  stop() {
    this.#state.isRunning = false;

    // A draw deferred to the render loop may still be pending (for instance a
    // layer that became ready during the last frame). Since no further frame
    // will run, it has to be honored now to keep the canvas current.
    this.#refreshTickets();
  }

  #step = (now: number) => {
    if (!this.isRunning) return;

    const stepParams = {
      now,
      offset: now - this.#state.lastCallTime,
      ...(this.target && {
        width: this.target.width,
        height: this.target.height,
      }),
    };

    this.layers.forEach((layer) => layer.onStep?.(stepParams, layer));
    this.onStep?.(stepParams);

    this.draw();
    this.#state.lastCallTime = now;
    requestAnimationFrame(this.#step);
  };

  clear = () =>
    this.#state.context &&
    this.#state.context.clearRect(0, 0, this.target.width, this.target.height);

  draw = (): void => {
    const { context } = this.#state;

    if (!context) return;

    // An explicit or frame draw renders the current stack, which makes any
    // ticket that is already satisfied redundant.
    this.#collectReadyTickets();

    this.clear();

    this.layers.forEach((layer) => {
      const { source } = layer;

      // Layers whose source has not resolved yet (or failed to load) are
      // skipped without preventing the remaining layers from being drawn.
      if (!source || !layer.isActive || !(layer.opacity > 0)) return;

      context.globalAlpha = layer.opacity;

      try {
        context.drawImage(source, layer.posX, layer.posY);
      } catch {
        // A single broken source must not abort the frame or leave the engine
        // stuck in an error loop.
      }
    });
  };
}
