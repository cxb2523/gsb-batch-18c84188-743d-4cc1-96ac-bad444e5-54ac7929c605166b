// Per-tool "save default style" on DrawingManager: save / clear / query, per-kind isolation, deep
// copies, undo back to the previous effective default, one `change` per step, and new drawings /
// placement preview picking the default up while existing drawings keep their own style.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_STYLE, factoryStyleFor, setDefaultStyleOverride, type DrawingKind, type DrawingStyle } from "../src";
import { ptr, setup } from "./pointer-harness";

beforeEach(() => setDefaultStyleOverride(() => undefined));
afterEach(() => {
  setDefaultStyleOverride(() => undefined);
  vi.unstubAllGlobals();
});

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** Save a default built from the factory style plus `patch`. */
function saved(kind: DrawingKind, patch: Partial<DrawingStyle>) {
  return { ...factoryStyleFor(kind), ...patch };
}

describe("saveDefaultStyle: new drawings use the saved default", () => {
  it("a trend line added after saving gets the saved style; query returns it", () => {
    const s = setup();
    const style = saved("trend-line", { color: "#f23645", width: 3, lineStyle: "dashed" });
    s.dm.saveDefaultStyle("trend-line", style);

    expect(s.dm.defaultStyleFor("trend-line")).toEqual(style);
    expect(s.dm.hasDefaultStyle("trend-line")).toBe(true);

    const id = s.dm.add({ kind: "trend-line", points: [{ time: 100 as never, price: 300 }, { time: 200 as never, price: 200 }] });
    expect(s.dm.get(id)!.style).toEqual(style);
  });

  it("a drawing added with no style also picks the saved default", () => {
    const s = setup();
    s.dm.saveDefaultStyle("rectangle", { ...factoryStyleFor("rectangle"), color: "#00ff00", transparency: 10 });
    const id = s.dm.add({ kind: "rectangle", points: [{ time: 100 as never, price: 300 }, { time: 200 as never, price: 200 }] });
    expect(s.dm.get(id)!.style.color).toBe("#00ff00");
    expect(s.dm.get(id)!.style.transparency).toBe(10);
  });

  it("saveStyleAsDefault uses an existing drawing's own style", () => {
    const s = setup();
    const id = s.dm.add({
      kind: "trend-line",
      points: [{ time: 100 as never, price: 300 }, { time: 200 as never, price: 200 }],
      style: { ...factoryStyleFor("trend-line"), color: "#123456" },
    });
    expect(s.dm.saveStyleAsDefault(id)).toBe(true);
    expect(s.dm.defaultStyleFor("trend-line").color).toBe("#123456");
    // the source drawing is not touched
    expect(s.dm.get(id)!.style.color).toBe("#123456");
  });

  it("saveStyleAsDefault of an unknown id is a no-op", () => {
    const s = setup();
    const change = vi.fn();
    s.dm.on("change", change);
    expect(s.dm.saveStyleAsDefault("nope")).toBe(false);
    expect(s.dm.hasDefaultStyle("trend-line")).toBe(false);
    expect(change).not.toHaveBeenCalled();
  });

  it("saveDefaultStyle with no style snapshots the current effective default", () => {
    const s = setup();
    s.dm.saveDefaultStyle("trend-line");
    expect(s.dm.hasDefaultStyle("trend-line")).toBe(true);
    expect(s.dm.getDefaultStyle("trend-line")).toEqual(factoryStyleFor("trend-line"));
  });
});

describe("placement preview uses the saved default", () => {
  it("an armed trend line previews in the saved colour / width", () => {
    const s = setup();
    s.dm.saveDefaultStyle("trend-line", saved("trend-line", { color: "#abcdef", width: 4 }));
    s.dm.setTool("trend-line");
    // One click of a two-point tool leaves a pending point and a live preview.
    s.el.dispatchEvent(ptr("pointerdown", "mouse", 100, 200));
    s.win.dispatchEvent(ptr("pointerup", "mouse", 100, 200));

    const scenes = s.dm.scenes(800, 500);
    expect(scenes.length).toBe(1); // only the preview
    const lines = scenes[0].scene.filter((it) => it.t === "line");
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((it) => it.t === "line" && it.stroke === "#abcdef")).toBe(true);
    expect(lines.every((it) => it.t === "line" && it.strokeWidth === 4)).toBe(true);
  });

  it("the committed drawing matches what the preview showed", () => {
    const s = setup();
    s.dm.saveDefaultStyle("trend-line", saved("trend-line", { color: "#abcdef", width: 4 }));
    s.dm.setTool("trend-line");
    s.el.dispatchEvent(ptr("pointerdown", "mouse", 100, 200));
    s.win.dispatchEvent(ptr("pointerup", "mouse", 100, 200));
    const previewStroke = s.dm
      .scenes(800, 500)[0]
      .scene.filter((it) => it.t === "line")
      .find((it) => it.t === "line") as Extract<ReturnType<typeof s.dm.scenes>[number]["scene"][number], { t: "line" }>;
    s.el.dispatchEvent(ptr("pointerdown", "mouse", 300, 300));
    s.win.dispatchEvent(ptr("pointerup", "mouse", 300, 300));
    const d = s.dm.drawings()[0];
    expect(d.style.color).toBe(previewStroke.stroke);
    expect(d.style.width).toBe(previewStroke.strokeWidth);
  });
});

describe("overrides are isolated per tool kind", () => {
  it("saving a trend line default leaves fib retracement on its factory style", () => {
    const s = setup();
    s.dm.saveDefaultStyle("trend-line", saved("trend-line", { color: "#f23645" }));
    expect(s.dm.hasDefaultStyle("fib-retracement")).toBe(false);
    expect(s.dm.defaultStyleFor("fib-retracement")).toEqual(factoryStyleFor("fib-retracement"));
    const id = s.dm.add({ kind: "fib-retracement", points: [{ time: 100 as never, price: 100 }, { time: 200 as never, price: 200 }] });
    expect(s.dm.get(id)!.style.color).toBe(factoryStyleFor("fib-retracement").color);
  });

  it("each kind keeps its own saved default", () => {
    const s = setup();
    s.dm.saveDefaultStyle("trend-line", saved("trend-line", { color: "#111111" }));
    s.dm.saveDefaultStyle("fib-retracement", saved("fib-retracement", { color: "#222222" }));
    expect(s.dm.defaultStyleFor("trend-line").color).toBe("#111111");
    expect(s.dm.defaultStyleFor("fib-retracement").color).toBe("#222222");
    s.dm.clearDefaultStyle("trend-line");
    expect(s.dm.hasDefaultStyle("fib-retracement")).toBe(true);
  });
});

describe("clearDefaultStyle restores the factory (and host) default", () => {
  it("after clear the query and new drawings are on the factory style", () => {
    const s = setup();
    s.dm.saveDefaultStyle("trend-line", saved("trend-line", { color: "#f23645", width: 5 }));
    s.dm.clearDefaultStyle("trend-line");
    expect(s.dm.hasDefaultStyle("trend-line")).toBe(false);
    expect(s.dm.defaultStyleFor("trend-line")).toEqual(factoryStyleFor("trend-line"));

    const id = s.dm.add({ kind: "trend-line", points: [{ time: 100 as never, price: 300 }, { time: 200 as never, price: 200 }] });
    expect(s.dm.get(id)!.style).toEqual(factoryStyleFor("trend-line"));
  });

  it("clearing a kind with no override is a no-op and emits nothing", () => {
    const s = setup();
    const change = vi.fn();
    s.dm.on("change", change);
    s.dm.clearDefaultStyle("trend-line");
    expect(change).not.toHaveBeenCalled();
  });
});

describe("array fields are deep-copied", () => {
  it("two new fib drawings never share the levels array (nor its entries)", () => {
    const s = setup();
    const style = saved("fib-retracement", { levels: [...factoryStyleFor("fib-retracement").levels!] });
    s.dm.saveDefaultStyle("fib-retracement", style);

    const a = s.dm.add({ kind: "fib-retracement", points: [{ time: 100 as never, price: 100 }, { time: 200 as never, price: 200 }] });
    const b = s.dm.add({ kind: "fib-retracement", points: [{ time: 100 as never, price: 100 }, { time: 200 as never, price: 200 }] });
    const la = s.dm.get(a)!.style.levels!;
    const lb = s.dm.get(b)!.style.levels!;
    expect(la).not.toBe(lb);
    expect(la[0]).not.toBe(lb[0]);
    expect(la).toEqual(lb);

    la[0].color = "#000000";
    expect(lb[0].color).not.toBe("#000000");

    // The stored default and the query result are independent copies too.
    expect(s.dm.defaultStyleFor("fib-retracement").levels![0].color).not.toBe("#000000");
    s.dm.defaultStyleFor("fib-retracement").levels![1].color = "#000000";
    expect(s.dm.defaultStyleFor("fib-retracement").levels![1].color).not.toBe("#000000");
  });

  it("saving a style copies it: later edits of the input do not change the default", () => {
    const s = setup();
    const style = saved("fib-retracement", { levels: [...factoryStyleFor("fib-retracement").levels!] });
    s.dm.saveDefaultStyle("fib-retracement", style);
    style.levels![0].color = "#000000";
    expect(s.dm.defaultStyleFor("fib-retracement").levels![0].color).not.toBe("#000000");
  });

  it("array defaults set by the factory are also copied per drawing", () => {
    const s = setup();
    const a = s.dm.add({ kind: "gann-fan", points: [{ time: 100 as never, price: 100 }, { time: 200 as never, price: 200 }] });
    const b = s.dm.add({ kind: "gann-fan", points: [{ time: 100 as never, price: 100 }, { time: 200 as never, price: 200 }] });
    expect(s.dm.get(a)!.style.levels).not.toBe(s.dm.get(b)!.style.levels);
  });

  it("global factoryStyleFor / defaultStyleFor return deep copies", () => {
    const x = factoryStyleFor("fib-retracement");
    const y = factoryStyleFor("fib-retracement");
    expect(x.levels).not.toBe(y.levels);
    x.levels![0].color = "#000000";
    expect(y.levels![0].color).not.toBe("#000000");
  });
});

describe("existing drawings keep their style", () => {
  it("save / clear / undo do not touch an already placed drawing", () => {
    const s = setup();
    const id = s.dm.add({
      kind: "trend-line",
      points: [{ time: 100 as never, price: 300 }, { time: 200 as never, price: 200 }],
      style: { ...DEFAULT_STYLE, color: "#00ff00", width: 2 },
    });
    const before = clone(s.dm.get(id)!.style);
    const styleObject = s.dm.get(id)!.style;

    s.dm.saveDefaultStyle("trend-line", saved("trend-line", { color: "#f23645" }));
    expect(s.dm.get(id)!.style).toEqual(before);

    s.dm.saveDefaultStyle("trend-line", saved("trend-line", { color: "#123456" }));
    expect(s.dm.get(id)!.style).toEqual(before);

    s.dm.undoDefaultStyle("trend-line");
    expect(s.dm.get(id)!.style).toEqual(before);

    s.dm.clearDefaultStyle("trend-line");
    expect(s.dm.get(id)!.style).toEqual(before);
    expect(s.dm.get(id)!.style).toBe(styleObject);
  });

  it("a drawing placed before the save keeps its style; the next one takes the default", () => {
    const s = setup();
    const old = s.dm.add({ kind: "trend-line", points: [{ time: 100 as never, price: 300 }, { time: 200 as never, price: 200 }] });
    const oldStyle = clone(s.dm.get(old)!.style);
    s.dm.saveDefaultStyle("trend-line", saved("trend-line", { color: "#f23645" }));
    expect(s.dm.get(old)!.style).toEqual(oldStyle);
    const fresh = s.dm.add({ kind: "trend-line", points: [{ time: 100 as never, price: 300 }, { time: 200 as never, price: 200 }] });
    expect(s.dm.get(fresh)!.style.color).toBe("#f23645");
  });
});

describe("change events: one per save / clear / undo", () => {
  it("save, clear and undo each fire exactly one change", () => {
    const s = setup();
    const change = vi.fn();
    s.dm.on("change", change);

    s.dm.saveDefaultStyle("trend-line", saved("trend-line", { color: "#f23645" }));
    expect(change).toHaveBeenCalledTimes(1);

    s.dm.clearDefaultStyle("trend-line");
    expect(change).toHaveBeenCalledTimes(2);
    expect(s.dm.hasDefaultStyle("trend-line")).toBe(false);

    // clear is an undoable step: undo brings the dropped default back.
    expect(s.dm.undoDefaultStyle("trend-line")).toBe(true);
    expect(change).toHaveBeenCalledTimes(3);
    expect(s.dm.defaultStyleFor("trend-line").color).toBe("#f23645");
  });

  it("a save for one kind does not disturb another kind's default", () => {
    const s = setup();
    s.dm.saveDefaultStyle("fib-retracement", saved("fib-retracement", { color: "#222222" }));
    const change = vi.fn();
    s.dm.on("change", change);
    s.dm.saveDefaultStyle("trend-line", saved("trend-line", { color: "#111111" }));
    expect(change).toHaveBeenCalledTimes(1);
    expect(s.dm.defaultStyleFor("fib-retracement").color).toBe("#222222");
  });
});

describe("undoDefaultStyle", () => {
  it("after two saves undo goes back to the first saved default", () => {
    const s = setup();
    const first = saved("trend-line", { color: "#111111", width: 2 });
    const second = saved("trend-line", { color: "#222222", width: 6 });
    s.dm.saveDefaultStyle("trend-line", first);
    s.dm.saveDefaultStyle("trend-line", second);
    expect(s.dm.defaultStyleFor("trend-line")).toEqual(second);

    const change = vi.fn();
    s.dm.on("change", change);
    expect(s.dm.undoDefaultStyle("trend-line")).toBe(true);
    expect(change).toHaveBeenCalledTimes(1);
    expect(s.dm.defaultStyleFor("trend-line")).toEqual(first);

    // one record remains: a second undo drops the override entirely.
    expect(s.dm.undoDefaultStyle("trend-line")).toBe(true);
    expect(s.dm.hasDefaultStyle("trend-line")).toBe(false);
    expect(s.dm.defaultStyleFor("trend-line")).toEqual(factoryStyleFor("trend-line"));

    // nothing left to undo: no event.
    const after = vi.fn();
    s.dm.on("change", after);
    expect(s.dm.undoDefaultStyle("trend-line")).toBe(false);
    expect(after).not.toHaveBeenCalled();
  });

  it("a new drawing after the undo takes the restored default (not the undone one)", () => {
    const s = setup();
    const first = saved("trend-line", { color: "#111111" });
    s.dm.saveDefaultStyle("trend-line", first);
    s.dm.saveDefaultStyle("trend-line", saved("trend-line", { color: "#222222" }));
    s.dm.undoDefaultStyle("trend-line");
    const id = s.dm.add({ kind: "trend-line", points: [{ time: 100 as never, price: 300 }, { time: 200 as never, price: 200 }] });
    expect(s.dm.get(id)!.style.color).toBe("#111111");
  });

  it("with no kind, the latest save of any kind is undone", () => {
    const s = setup();
    s.dm.saveDefaultStyle("trend-line", saved("trend-line", { color: "#111111" }));
    s.dm.saveDefaultStyle("fib-retracement", saved("fib-retracement", { color: "#222222" }));
    expect(s.dm.undoDefaultStyle()).toBe(true);
    expect(s.dm.hasDefaultStyle("fib-retracement")).toBe(false);
    expect(s.dm.hasDefaultStyle("trend-line")).toBe(true);
  });

  it("the preview after an undo shows the restored default", () => {
    const s = setup();
    s.dm.saveDefaultStyle("trend-line", saved("trend-line", { color: "#111111" }));
    s.dm.saveDefaultStyle("trend-line", saved("trend-line", { color: "#222222" }));
    s.dm.undoDefaultStyle("trend-line");
    s.dm.setTool("trend-line");
    s.el.dispatchEvent(ptr("pointerdown", "mouse", 100, 200));
    s.win.dispatchEvent(ptr("pointerup", "mouse", 100, 200));
    const lines = s.dm.scenes(800, 500)[0].scene.filter((it) => it.t === "line");
    expect(lines.every((it) => it.t === "line" && it.stroke === "#111111")).toBe(true);
  });
});
