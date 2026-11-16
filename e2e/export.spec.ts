import { test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { openApp, drawShape, worldToClient, expect } from "./helpers";
import type { Download, Page } from "@playwright/test";

/** Open the menu and click an Export submenu entry by its (partial) label. */
async function openExport(page: Page, label: string): Promise<void> {
  const menu = page.locator("simple-whiteboard-menu");
  await menu.locator(".menu-button").click();
  await menu.locator(".menu-item", { hasText: "Export" }).first().hover();
  await menu.locator(".submenu-item", { hasText: label }).click();
}

/** Assert a captured download is a PNG with the expected filename prefix. */
async function expectPng(download: Download, prefix: RegExp): Promise<void> {
  expect(download.suggestedFilename()).toMatch(prefix);
  const path = await download.path();
  const bytes = readFileSync(path);
  // PNG magic number: 89 50 4E 47.
  expect([bytes[0], bytes[1], bytes[2], bytes[3]]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  expect(bytes.length).toBeGreaterThan(100);
}

/**
 * Set the camera directly, so a test exercises a known non-default zoom/pan
 * without depending on wheel/pinch heuristics.
 */
async function setView(
  page: Page,
  zoom: number,
  panX: number,
  panY: number
): Promise<void> {
  await page.evaluate(
    ([z, px, py]) => {
      const app = document.getElementById("app") as any;
      const coords = app.getCoordsContext();
      coords.setZoom(z);
      coords.setCoords(px, py);
      app.draw();
    },
    [zoom, panX, panY] as const
  );
  // Let the coalesced redraw land before touching the canvas.
  await page.waitForTimeout(50);
}

interface PngMeasurement {
  width: number;
  height: number;
  /** Bounding box (pixels) of the strongly red content, if any. */
  red: { minX: number; minY: number; maxX: number; maxY: number; count: number } | null;
  /**
   * Median horizontal spacing (pixels) between the dotted-background columns
   * found in the requested band, or `null` when the band has no dots.
   */
  dotSpacing: number | null;
}

/**
 * Decode a PNG in the browser and measure the two things the export tests care
 * about: where the red probe shape landed, and how far apart the background
 * dots are. Running the scan in the page avoids pulling an image decoder into
 * the test runner.
 */
async function measurePng(
  page: Page,
  base64: string,
  band?: [number, number]
): Promise<PngMeasurement> {
  return page.evaluate(
    async ([b64, rows]) => {
      const img = new Image();
      img.src = "data:image/png;base64," + b64;
      await img.decode();

      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(img, 0, 0);
      const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);

      // Composite onto white (canvases may be transparent) and look for the
      // strongly red probe shape.
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      let count = 0;
      const dotColumns: number[] = [];
      const rowFrom = rows ? Math.max(0, Math.floor(rows[0])) : 0;
      const rowTo = rows ? Math.min(canvas.height, Math.ceil(rows[1])) : canvas.height;

      for (let y = 0; y < canvas.height; y++) {
        const inBand = y >= rowFrom && y < rowTo;
        for (let x = 0; x < canvas.width; x++) {
          const i = (y * canvas.width + x) * 4;
          const alpha = data[i + 3] / 255;
          const r = data[i] * alpha + 255 * (1 - alpha);
          const g = data[i + 1] * alpha + 255 * (1 - alpha);
          const b = data[i + 2] * alpha + 255 * (1 - alpha);

          if (r > 150 && g < 130 && b < 130) {
            count++;
            minX = Math.min(minX, x);
            minY = Math.min(minY, y);
            maxX = Math.max(maxX, x);
            maxY = Math.max(maxY, y);
          }

          // The dotted background (#d7dbe3) is a light, slightly blue grey.
          if (inBand && r <= 240 && b - r >= 6 && g >= r) {
            dotColumns.push(x);
          }
        }
      }

      // Group hit columns into dots and take the median gap between them.
      const centers: number[] = [];
      let start = -1;
      let prev = -2;
      for (const x of dotColumns) {
        if (x !== prev + 1) {
          if (start >= 0) centers.push((start + prev) / 2);
          start = x;
        }
        prev = x;
      }
      if (start >= 0) centers.push((start + prev) / 2);
      const gaps: number[] = [];
      for (let i = 1; i < centers.length; i++) gaps.push(centers[i] - centers[i - 1]);
      gaps.sort((a, b) => a - b);

      return {
        width: canvas.width,
        height: canvas.height,
        red: count
          ? { minX, minY, maxX, maxY, count }
          : null,
        dotSpacing: gaps.length ? gaps[Math.floor(gaps.length / 2)] : null,
      };
    },
    [base64, band ?? null] as const
  );
}

/** Read a download's bytes and hand them to {@link measurePng}. */
async function measureDownload(
  page: Page,
  download: Download,
  band?: [number, number]
): Promise<PngMeasurement> {
  const base64 = readFileSync(await download.path()).toString("base64");
  return measurePng(page, base64, band);
}

/** Screenshot the live canvas (base64 PNG) for on-screen measurements. */
async function screenPng(page: Page): Promise<string> {
  return page.evaluate(() => {
    const app = document.getElementById("app") as any;
    const canvas = app.shadowRoot.querySelector("canvas") as HTMLCanvasElement;
    // Redraws are coalesced into an animation frame; force a synchronous one
    // so the captured pixels match the current camera.
    app.renderer.flush();
    return canvas.toDataURL("image/png").split(",")[1];
  });
}

/** Drag a marquee between two world-space points. */
async function dragMarquee(
  page: Page,
  ax: number,
  ay: number,
  bx: number,
  by: number
): Promise<void> {
  const a = await worldToClient(page, ax, ay);
  const b = await worldToClient(page, bx, by);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 4 });
  await page.mouse.move(b.x, b.y, { steps: 4 });
  await page.mouse.up();
}

/** Whether the whiteboard is currently picking an area to export. */
async function isSelectingArea(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const app = document.getElementById("app") as any;
    return app.exporter.isSelectingArea as boolean;
  });
}

test.beforeEach(async ({ page }) => {
  await openApp(page);
  // The floating tool-options panel overlaps the top-left of the canvas; hide
  // it so marquee drags always land on the canvas itself.
  await page.evaluate(() => {
    (document.getElementById("app") as any).hideToolOptions = true;
  });
  await drawShape(page, "rect", -200, -80, -60, 30, {
    strokeWidth: 1,
    stroke: "#000000",
    fill: "#ff0000",
    fillStyle: "solid",
  });
});

test("exports the current view as a PNG", async ({ page }) => {
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    openExport(page, "Current view"),
  ]);
  await expectPng(download, /^whiteboard-\d.*\.png$/);
});

test("exports the full view as a PNG", async ({ page }) => {
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    openExport(page, "Full view"),
  ]);
  await expectPng(download, /^whiteboard-full-.*\.png$/);
});

test("exports a selected area as a PNG after dragging a marquee", async ({ page }) => {
  await openExport(page, "Selected area");

  // We are now in area-select mode: dragging a rectangle triggers the export.
  const downloadPromise = page.waitForEvent("download");
  const a = await worldToClient(page, -120, -60);
  const b = await worldToClient(page, 160, 80);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 4 });
  await page.mouse.move(b.x, b.y, { steps: 4 });
  await page.mouse.up();

  const download = await downloadPromise;
  await expectPng(download, /^whiteboard-area-.*\.png$/);
});

test("pressing Escape cancels the area-export selection", async ({ page }) => {
  await openExport(page, "Selected area");

  // After Escape the marquee is cancelled, so a subsequent drag must not export.
  await page.keyboard.press("Escape");

  let downloaded = false;
  page.on("download", () => (downloaded = true));
  const a = await worldToClient(page, -100, -50);
  const b = await worldToClient(page, 100, 50);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  expect(downloaded).toBe(false);
});

/**
 * The exported region must be exactly what the marquee covered, at any zoom and
 * pan. This checks both the output size (region size × one uniform scale) and
 * where the red probe shape lands inside it.
 */
for (const [zoom, panX, panY] of [
  [2, 75, -40],
  [0.5, -180, 90],
  [1.75, 137.4, -63.2],
] as const) {
  test(`selected-area export matches the marquee at zoom ${zoom} (pan ${panX}, ${panY})`, async ({
    page,
  }) => {
    await setView(page, zoom, panX, panY);

    // World-space region around the red rect (-200,-80)-(-60,30).
    const region = { x: -230, y: -110, width: 200, height: 170 };
    const scale = 2;

    const downloadPromise = page.waitForEvent("download");
    await openExport(page, "Selected area");
    await dragMarquee(
      page,
      region.x,
      region.y,
      region.x + region.width,
      region.y + region.height
    );
    const info = await measureDownload(page, await downloadPromise);

    // Size: region size × the uniform export scale, capped by the max side.
    // The marquee is picked in whole canvas pixels, so at a fractional zoom the
    // world size it maps to can differ from the requested one by up to one
    // screen pixel (× the export scale): allow a couple of pixels.
    const tolerance = 2;
    expect(Math.abs(info.width - region.width * scale)).toBeLessThanOrEqual(tolerance);
    expect(Math.abs(info.height - region.height * scale)).toBeLessThanOrEqual(tolerance);
    // Both axes must share one scale: the aspect ratio is preserved.
    expect(info.width / info.height).toBeCloseTo(region.width / region.height, 1);

    // Content: the red rect must sit where its world coordinates map to.
    expect(info.red).not.toBeNull();
    const expected = {
      minX: (-200 - region.x) * scale,
      minY: (-80 - region.y) * scale,
      maxX: (-60 - region.x) * scale,
      maxY: (30 - region.y) * scale,
    };
    expect(Math.abs(info.red!.minX - expected.minX)).toBeLessThanOrEqual(3);
    expect(Math.abs(info.red!.minY - expected.minY)).toBeLessThanOrEqual(3);
    expect(Math.abs(info.red!.maxX - expected.maxX)).toBeLessThanOrEqual(3);
    expect(Math.abs(info.red!.maxY - expected.maxY)).toBeLessThanOrEqual(3);
  });
}

test("selected-area export is stable across zoom and pan", async ({ page }) => {
  // The same world region exported from three very different cameras: the
  // re-render is world-based, so the content must land identically.
  const region = { x: -240, y: -120, width: 220, height: 190 };
  const measurements: PngMeasurement[] = [];

  for (const [zoom, panX, panY] of [
    [1, 0, 0],
    [2.5, -310, 145],
    [0.4, 220, -180],
  ] as const) {
    await setView(page, zoom, panX, panY);
    const downloadPromise = page.waitForEvent("download");
    await page.evaluate(
      (r) => (document.getElementById("app") as any).downloadRegionAsPng(r),
      region
    );
    measurements.push(await measureDownload(page, await downloadPromise));
  }

  const [first, ...rest] = measurements;
  for (const other of rest) {
    expect([other.width, other.height]).toEqual([first.width, first.height]);
    // Same world region -> same export pixels, whether the camera is zoomed
    // in, zoomed out, or panned far away.
    expect(other.red).not.toBeNull();
    expect(first.red).not.toBeNull();
    expect(Math.abs(other.red!.minX - first.red!.minX)).toBeLessThanOrEqual(1);
    expect(Math.abs(other.red!.minY - first.red!.minY)).toBeLessThanOrEqual(1);
    expect(Math.abs(other.red!.maxX - first.red!.maxX)).toBeLessThanOrEqual(1);
    expect(Math.abs(other.red!.maxY - first.red!.maxY)).toBeLessThanOrEqual(1);
  }
});

test("dotted background in an export uses the same world grid as the screen", async ({
  page,
}) => {
  // Only the background is measured, so start from an empty board.
  await page.evaluate(() => (document.getElementById("app") as any).clear());
  await page.evaluate(() => {
    (document.getElementById("app") as any).dottedBackground = true;
  });

  const region = { x: -150, y: -100, width: 300, height: 200 };

  for (const [zoom, panX, panY] of [
    [1, 0, 0],
    [2, 60, -30],
    [0.5, -140, 75],
  ] as const) {
    await setView(page, zoom, panX, panY);

    const screen = await measurePng(page, await screenPng(page));
    const downloadPromise = page.waitForEvent("download");
    await page.evaluate(
      (r) => (document.getElementById("app") as any).downloadRegionAsPng(r),
      region
    );
    const exported = await measureDownload(page, await downloadPromise);

    expect(screen.dotSpacing).not.toBeNull();
    expect(exported.dotSpacing).not.toBeNull();

    // Exports render one world unit as `scale` pixels while the screen renders
    // it as `zoom` pixels, so the dot spacing must scale by scale / zoom.
    const scale = Math.min(2, 4096 / Math.max(region.width, region.height));
    const expectedSpacing = screen.dotSpacing! * (scale / zoom);
    expect(Math.abs(exported.dotSpacing! - expectedSpacing)).toBeLessThanOrEqual(
      expectedSpacing * 0.08
    );
  }
});

test("the exported background follows the dotted-background setting", async ({ page }) => {
  await page.evaluate(() => (document.getElementById("app") as any).clear());
  await page.evaluate(() => {
    (document.getElementById("app") as any).dottedBackground = false;
  });

  const downloadPromise = page.waitForEvent("download");
  await page.evaluate(() =>
    (document.getElementById("app") as any).downloadRegionAsPng({
      x: -150,
      y: -100,
      width: 300,
      height: 200,
    })
  );
  const info = await measureDownload(page, await downloadPromise);
  expect(info.dotSpacing).toBeNull();
});

test("a tiny marquee does not download, and leaves the mode", async ({ page }) => {
  await openExport(page, "Selected area");
  expect(await isSelectingArea(page)).toBe(true);

  let downloaded = false;
  page.on("download", () => (downloaded = true));

  // A 2×2 canvas-pixel drag is a mis-click, not a selection.
  const a = await worldToClient(page, 40, 40);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(a.x + 2, a.y + 2, { steps: 2 });
  await page.mouse.up();
  await page.waitForTimeout(300);

  expect(downloaded).toBe(false);
  expect(await isSelectingArea(page)).toBe(false);
  expect(
    await page.evaluate(() => (document.getElementById("app") as any).getCursor())
  ).toBe("default");

  // The mode is over: a further drag must not export either.
  await dragMarquee(page, -120, -60, 120, 60);
  await page.waitForTimeout(300);
  expect(downloaded).toBe(false);
});

test("Escape during a drag cancels the pending export", async ({ page }) => {
  await openExport(page, "Selected area");

  let downloaded = false;
  page.on("download", () => (downloaded = true));

  const a = await worldToClient(page, -120, -60);
  const b = await worldToClient(page, 120, 60);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 3 });

  // Cancel while the button is still down; releasing must not export.
  await page.keyboard.press("Escape");
  expect(await isSelectingArea(page)).toBe(false);
  await page.mouse.move(b.x, b.y, { steps: 3 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  expect(downloaded).toBe(false);

  // A following drag must not export either.
  await dragMarquee(page, -120, -60, 120, 60);
  await page.waitForTimeout(300);
  expect(downloaded).toBe(false);
});

test("downloadRegion ignores a region with no area", async ({ page }) => {
  let downloaded = false;
  page.on("download", () => (downloaded = true));

  await page.evaluate(() => {
    const app = document.getElementById("app") as any;
    app.downloadRegionAsPng({ x: 0, y: 0, width: 0, height: 120 });
    app.downloadRegionAsPng({ x: 0, y: 0, width: 120, height: -5 });
  });
  await page.waitForTimeout(300);
  expect(downloaded).toBe(false);
});

test("empty board full view falls back to the current view", async ({ page }) => {
  await page.evaluate(() => (document.getElementById("app") as any).clear());
  const canvasSize = await page.evaluate(() => {
    const app = document.getElementById("app") as any;
    const canvas = app.shadowRoot.querySelector("canvas") as HTMLCanvasElement;
    return { width: canvas.width, height: canvas.height };
  });

  const downloadPromise = page.waitForEvent("download");
  await openExport(page, "Full view");
  const download = await downloadPromise;
  await expectPng(download, /^whiteboard-full-.*\.png$/);

  const info = await measureDownload(page, download);
  expect([info.width, info.height]).toEqual([
    canvasSize.width,
    canvasSize.height,
  ]);
});
