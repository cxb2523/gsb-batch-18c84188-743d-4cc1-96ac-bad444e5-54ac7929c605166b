import { expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import { renderPlayer } from "./player";

function seekSlider() {
    return page.getByRole("slider", { name: "Seek" });
}

test("the slider, timestamp and hover preview keep showing the target time while adjusting, ignoring timeupdate events", async () => {
    const video = await renderPlayer();
    const seek = seekSlider();
    await expect.element(seek).toHaveAttribute("aria-valuemax", "4");
    await expect.element(seek).toHaveAttribute("aria-valuenow", "0");

    const sliderRoot = page.getByTestId("seek-slider-root");
    const rect = (sliderRoot.element() as HTMLElement).getBoundingClientRect();

    // Real Playwright drag from 25% to 75% of the 200px-wide root. 75% of a 4s
    // clip is the 3s target. The viewport overlay intercepts hit-testing, so
    // the events are forced straight onto the slider root.
    await sliderRoot.dropTo(sliderRoot, {
        sourcePosition: { x: rect.width * 0.25, y: rect.height / 2 },
        targetPosition: { x: rect.width * 0.75, y: rect.height / 2 },
        force: true,
    } as Parameters<typeof sliderRoot.dropTo>[0]);

    // Radix rounds to the step (0.001): 75% of a 4 second clip is 3s.
    await expect.element(seek).toHaveAttribute("aria-valuenow", "3");
    expect(page.getByTestId("seek-tooltip-label").element().textContent).toBe("75.0%");
    await expect.element(page.getByText("00:03")).toBeVisible();

    // After release the media element's actual time is the source of truth.
    await expect.poll(() => video.currentTime).toBe(3);
    await expect.element(seek).toHaveAttribute("aria-valuenow", "3");
});

test("timeupdate events cannot override the target time while a pointer drag is held open", async () => {
    const video = await renderPlayer();
    const seek = seekSlider();
    const sliderRoot = page.getByTestId("seek-slider-root");
    const rootEl = sliderRoot.element() as HTMLElement;
    const rect = rootEl.getBoundingClientRect();

    // Inject conflicting timeupdate events on the first real pointermove that
    // reaches a non-zero target, while Radix still holds pointer capture and
    // the interaction session is open. The slider, hover preview and timestamp
    // must all stay anchored to the user's target instead of jumping to 0.
    let injected = false;
    const held: { slider: string | null; tooltip: string | null; timestamp: string | null } = {
        slider: null,
        tooltip: null,
        timestamp: null,
    };
    rootEl.addEventListener("pointermove", function handler() {
        const value = seek.element().getAttribute("aria-valuenow");
        if (injected || !(value && Number(value) > 0)) return;
        injected = true;
        video.currentTime = 0;
        video.dispatchEvent(new Event("timeupdate"));
        video.dispatchEvent(new Event("timeupdate"));
        held.slider = seek.element().getAttribute("aria-valuenow");
        held.tooltip = page.getByTestId("seek-tooltip-label").element().textContent;
        held.timestamp = document.body.textContent?.match(/00:0\d/)?.[0] ?? null;
        rootEl.removeEventListener("pointermove", handler);
    });

    // Real Playwright drag from 25% to 75% of the 200px-wide root; the viewport
    // overlay intercepts hit-testing so the events are forced onto the root.
    await sliderRoot.dropTo(sliderRoot, {
        sourcePosition: { x: rect.width * 0.25, y: rect.height / 2 },
        targetPosition: { x: rect.width * 0.75, y: rect.height / 2 },
        force: true,
    } as Parameters<typeof sliderRoot.dropTo>[0]);

    // The conflicting timeupdate fired mid-drag and nothing followed it.
    expect(injected).toBe(true);
    // 25% of a 4s clip is 1s: every surface kept the in-flight target.
    expect(held.slider).toBe("1");
    expect(held.tooltip).toBe("25.0%");
    expect(held.timestamp).toBe("00:01");

    // After release the drag finishes at 75% (3s) and the media element's real
    // current time becomes the single source of truth.
    await expect.poll(() => video.currentTime).toBe(3);
    await expect.element(seek).toHaveAttribute("aria-valuenow", "3");
    expect(page.getByTestId("seek-tooltip-label").element().textContent).toBe("75.0%");
    await expect.element(page.getByText("00:03")).toBeVisible();
});

test("the display falls back to the media element's actual current time after a keyboard seek commits", async () => {
    const video = await renderPlayer();
    const seek = seekSlider();

    await userEvent.click(seek);
    await userEvent.keyboard("{ArrowRight}");
    await userEvent.keyboard("{ArrowRight}");

    // The keyboard step is one second; two presses target 2s and the media
    // element accepts the seek immediately.
    expect(video.currentTime).toBe(2);
    await expect.element(seek).toHaveAttribute("aria-valuenow", "2");
    await expect.element(page.getByText("00:02")).toBeVisible();

    // Once committed, a later timeupdate drives the display normally again.
    video.currentTime = 1.5;
    video.dispatchEvent(new Event("timeupdate"));
    await expect.poll(() => video.currentTime).toBe(1.5);
    await expect.element(seek).toHaveAttribute("aria-valuenow", "1.5");
    await expect.element(page.getByText("00:01")).toBeVisible();
});

test("the display re-aligns with the media element when it clamps the target time", async () => {
    const video = await renderPlayer();
    const seek = seekSlider();

    // Make the media element reject seeks beyond 2s by clamping the
    // currentTime setter, mirroring a seek outside the seekable ranges.
    const descriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "currentTime")!;
    Object.defineProperty(video, "currentTime", {
        configurable: true,
        enumerable: true,
        get: descriptor.get,
        set(value: number) {
            descriptor.set!.call(video, Math.min(value, 2));
        },
    });

    await userEvent.click(seek);
    await userEvent.keyboard("{End}");

    // The target was 4s but the media clamped it to 2s; the UI must match the
    // media element rather than keep showing the rejected target.
    await expect.poll(() => video.currentTime).toBe(2);
    await expect.element(seek).toHaveAttribute("aria-valuenow", "2");
    await expect.element(page.getByText("00:02")).toBeVisible();
});

test("buffered range changes re-sync the hover preview and slider when the current time is no longer playable", async () => {
    const video = await renderPlayer();
    const seek = seekSlider();
    const tooltip = page.getByTestId("seek-tooltip-label");

    // Seek to 3s and let it settle.
    await userEvent.click(seek);
    for (let i = 0; i < 3; i++) {
        await userEvent.keyboard("{ArrowRight}");
    }
    await expect.poll(() => video.currentTime).toBe(3);
    await expect.element(seek).toHaveAttribute("aria-valuenow", "3");
    expect(tooltip.element().textContent).toBe("75.0%");

    // Shrink the buffered ranges so 3s falls outside them and notify via a
    // progress event, as the browser does when buffers change.
    const makeRanges = (end: number): TimeRanges => {
        const ranges = Object.create(TimeRanges.prototype) as TimeRanges;
        Object.defineProperties(ranges, {
            length: { value: 1 },
            start: { value: (index: number) => (index === 0 ? 0 : 0) },
            end: { value: (index: number) => (index === 0 ? end : 0) },
        });
        return ranges;
    };
    Object.defineProperty(video, "buffered", {
        configurable: true,
        enumerable: true,
        get: () => makeRanges(2),
    });
    video.dispatchEvent(new Event("progress"));

    // The slider and hover preview snap to the nearest buffered edge (2s);
    // they must not stay stuck at the stale 3s / 75% values.
    await expect.element(seek).toHaveAttribute("aria-valuenow", "2");
    expect(tooltip.element().textContent).toBe("50.0%");
    // The single buffered range now ends at 2s, i.e. 50% of the 4s clip.
    expect(page.getByTestId("buffered-range").element().getAttribute("style")).toContain("width: 50%");

    // Expanding the buffer again makes the real current time reachable and the
    // display returns to it.
    Object.defineProperty(video, "buffered", {
        configurable: true,
        enumerable: true,
        get: () => makeRanges(4),
    });
    video.dispatchEvent(new Event("progress"));

    await expect.element(seek).toHaveAttribute("aria-valuenow", "3");
    expect(tooltip.element().textContent).toBe("75.0%");
});

test("the progress bar stays disabled without throwing when the media has no usable duration", async () => {
    const video = await renderPlayer({ preload: "none" });
    const seek = seekSlider();

    expect(video.readyState).toBe(HTMLMediaElement.HAVE_NOTHING);
    // Radix marks disabled sliders with data-disabled and aria-disabled rather
    // than the native disabled attribute.
    await expect.element(seek).toHaveAttribute("data-disabled", "");
    await expect.element(seek).toHaveAttribute("aria-valuemax", "1");
    await expect.element(seek).toHaveAttribute("aria-valuenow", "0");
});
