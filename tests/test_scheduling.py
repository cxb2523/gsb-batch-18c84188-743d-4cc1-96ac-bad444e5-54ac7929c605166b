"""
Test scheduling mechanics, by implementing a minimal canvas class to
implement drawing. This tests the basic scheduling mechanics, as well
as the behavior of the different update modes.
"""

import os
import time

from testutils import run_tests

from rendercanvas.base import BaseCanvasGroup, BaseRenderCanvas
from rendercanvas.offscreen import StubLoop


class MyCanvasGroup(BaseCanvasGroup):
    pass


class MyLoop(StubLoop):
    pass

    # Note: run() is non-blocking and simply does one iteration to process pending tasks.


class StubContext:
    def _rc_present(self, force_sync=False):
        return {"method": "skip"}

    def _rc_close(self):
        pass


class MyCanvas(BaseRenderCanvas):
    _rc_canvas_group = MyCanvasGroup(MyLoop())

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.draw_count = 0
        self.events_count = 0
        self._gui_draw_requested = False
        self._present_to_screen = False
        self._canvas_context = StubContext()

    def _process_events(self):
        self.events_count += 1
        return super()._process_events()

    def _draw_and_present(self, *, force_sync):
        super()._draw_and_present(force_sync=force_sync)
        self.draw_count += 1

    def active_sleep(self, delay):
        loop = self._rc_canvas_group.get_loop()  # <----
        etime = time.perf_counter() + delay
        while time.perf_counter() < etime:
            time.sleep(0.001)
            loop.run()


def test_scheduling_manual():
    canvas = MyCanvas(min_fps=0.000001, max_fps=100, update_mode="manual")

    # Booting ...
    canvas.active_sleep(0.001)
    assert canvas.draw_count == 0
    assert canvas.events_count == 0

    # No draws, even after the 0.1 init time
    canvas.active_sleep(0.11)
    assert canvas.draw_count == 0
    assert canvas.events_count in range(1, 11)

    # Requesting a draw ... has no effect
    canvas.request_draw()
    canvas.active_sleep(0.11)
    assert canvas.draw_count == 0
    assert canvas.events_count in range(1, 30)

    # Only when we force one
    canvas.force_draw()
    assert canvas.draw_count == 1


def test_scheduling_ondemand():
    canvas = MyCanvas(min_fps=0.000001, max_fps=100, update_mode="ondemand")

    # There's a small startup time, so no activity at first
    canvas.active_sleep(0.001)
    assert canvas.draw_count == 0
    assert canvas.events_count == 0

    # The first draw is scheduled for 0.1 s after initialization
    canvas.active_sleep(0.11)
    assert canvas.draw_count == 1
    assert canvas.events_count in range(1, 11)

    # No next draw is scheduled until we request one
    canvas.active_sleep(0.11)
    assert canvas.draw_count == 1
    assert canvas.events_count in range(10, 22)

    # Requesting a draw ... has effect after a few loop ticks
    canvas.request_draw()
    assert canvas.draw_count == 1
    canvas.active_sleep(0.011)
    assert canvas.draw_count == 2

    # Forcing a draw has direct effect
    canvas.draw_count = canvas.events_count = 0
    canvas.force_draw()
    assert canvas.draw_count == 1
    assert canvas.events_count == 0


def test_scheduling_ondemand_always_request_draw():
    # Test that using ondemand mode with a request_draw() in the
    # draw function, is equivalent to continuous mode.

    canvas = MyCanvas(max_fps=10, update_mode="ondemand")

    @canvas.request_draw
    def draw_func():
        canvas.request_draw()

    _test_scheduling_continuous(canvas)


def test_scheduling_continuous():
    canvas = MyCanvas(max_fps=10, update_mode="continuous")
    _test_scheduling_continuous(canvas)


def _test_scheduling_continuous(canvas):
    # There's a small startup time, so no activity at first
    canvas.active_sleep(0.001)
    assert canvas.draw_count == 0
    assert canvas.events_count == 0

    # The first draw is scheduled for 0.1 s after initialization
    canvas.active_sleep(0.11)
    assert canvas.draw_count == 1
    assert canvas.events_count == 1

    # And a second one after 0.1s, with 10 fps.
    canvas.active_sleep(0.11)
    assert canvas.draw_count in (2, 3)
    assert canvas.events_count in (2, 3)

    # And after one second, about 10 more
    canvas.draw_count = canvas.events_count = 0
    canvas.active_sleep(1)
    assert canvas.draw_count in range(9, 11)
    assert canvas.events_count in range(9, 11)

    # Forcing a draw has direct effect
    canvas.draw_count = canvas.events_count = 0
    canvas.force_draw()
    assert canvas.draw_count == 1
    assert canvas.events_count == 0


def test_scheduling_fastest():
    canvas = MyCanvas(max_fps=10, update_mode="fastest")

    # There's a small startup time, so no activity at first
    canvas.active_sleep(0.001)
    assert canvas.draw_count == 0
    assert canvas.events_count == 0

    # The first draw is scheduled for 0.1 s after initialization
    canvas.active_sleep(0.11)
    assert canvas.draw_count > 1
    assert canvas.events_count == canvas.draw_count

    # And after 0.1 s we have a lot more draws. max_fps is ignored
    canvas.draw_count = canvas.events_count = 0
    canvas.active_sleep(0.11)
    assert canvas.draw_count > (5 if os.getenv("CI") else 15)
    assert canvas.events_count == canvas.draw_count

    # Forcing a draw has direct effect
    canvas.draw_count = canvas.events_count = 0
    canvas.force_draw()
    assert canvas.draw_count == 1
    assert canvas.events_count == 0


# ==================== stopping the scheduler


class DrawCountCanvas(MyCanvas):
    """A canvas that counts the requests that the scheduler makes."""

    def __init__(self, *args, **kwargs):
        self.request_draw_count = 0
        super().__init__(*args, **kwargs)

    def _rc_request_draw(self):
        self.request_draw_count += 1
        super()._rc_request_draw()


def test_scheduling_close_stops_drawing():
    canvas = DrawCountCanvas(max_fps=100, update_mode="continuous")

    canvas.active_sleep(0.11)
    assert canvas.draw_count > 0

    canvas.close()
    assert canvas.get_closed()

    draws = canvas.draw_count
    requests = canvas.request_draw_count
    canvas.active_sleep(0.11)
    assert canvas.draw_count == draws
    assert canvas.request_draw_count == requests

    # After closing, requesting a draw or changing the update mode is a
    # no-op, and does not reactivate the scheduler.
    canvas.request_draw()
    canvas.set_update_mode("continuous")
    canvas.request_draw(lambda: None)
    canvas.active_sleep(0.11)
    assert canvas.draw_count == draws
    assert canvas.request_draw_count == requests


class StubSchedulerCanvas:
    """The minimal canvas interface that the Scheduler uses."""

    def get_closed(self):
        return False


class FakeEvent:
    def __init__(self):
        self.is_set = False

    def set(self):
        self.is_set = True


def test_scheduler_stop_wakes_waiting_present():
    from rendercanvas.core.scheduler import Scheduler

    canvas = StubSchedulerCanvas()
    scheduler = Scheduler(canvas, events=None, update_mode="ondemand")

    # Simulate that the scheduler is waiting for a draw to be presented.
    fake_event = FakeEvent()
    scheduler._ready_for_present = fake_event

    scheduler.stop()

    # The wait was cancelled, so the scheduler task can finish.
    assert fake_event.is_set
    assert scheduler._ready_for_present is None

    # Stopping twice is harmless.
    scheduler.stop()

    # And the scheduler no longer requests draws or changes its mode.
    scheduler._draw_requested = False
    mode, min_fps, max_fps = scheduler._mode, scheduler._min_fps, scheduler._max_fps
    scheduler.request_draw()
    scheduler.set_update_mode("continuous", min_fps=1, max_fps=5)
    scheduler.set_enabled(False)
    scheduler.set_enabled(True)
    assert scheduler._draw_requested is False
    assert (scheduler._mode, scheduler._min_fps, scheduler._max_fps) == (
        mode,
        min_fps,
        max_fps,
    )
    assert scheduler._enabled


if __name__ == "__main__":
    run_tests(globals())
