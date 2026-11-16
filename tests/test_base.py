"""
Test the base canvas class.
"""

import numpy as np
import pytest
import rendercanvas
from testutils import run_tests, can_use_wgpu_lib
from pytest import mark


def test_base_canvas_context():
    assert hasattr(rendercanvas.BaseRenderCanvas, "get_context")


class StubContext:
    def _rc_present(self, force_sync=False):
        return {"method": "skip"}


class SomeCanvasGroup(rendercanvas.base.BaseCanvasGroup):
    pass


class CanvasThatRaisesErrorsDuringDrawing(rendercanvas.base.BaseRenderCanvas):
    _rc_canvas_group = SomeCanvasGroup(None)

    def __init__(self):
        super().__init__()
        self._count = 0
        self._present_to_screen = False
        self._canvas_context = StubContext()

    def _draw_frame(self):
        self._count += 1
        if self._count <= 4:
            self.foo_method()
        else:
            self.spam_method()

    def foo_method(self):
        self.bar_method()

    def bar_method(self):
        raise Exception("call-failed-" + "but-test-passed")

    def spam_method(self):
        msg = "intended-fail"  # avoid line with the message to show in the tb
        raise Exception(msg)


def test_canvas_logging(caplog):
    """As we attempt to draw, the canvas will error, which are logged.
    Each first occurrence is logged with a traceback. Subsequent same errors
    are much shorter and have a counter.
    """

    canvas = CanvasThatRaisesErrorsDuringDrawing()

    canvas.force_draw()  # prints traceback
    canvas.force_draw()  # prints short logs ...
    canvas.force_draw()
    canvas.force_draw()

    text = caplog.text
    assert text.count("bar_method") == 2  # one traceback => 2 mentions
    assert text.count("foo_method") == 2
    assert text.count("call-failed-but-test-passed") == 4
    assert text.count("(4)") == 1
    assert text.count("(5)") == 0

    assert text.count("spam_method") == 0
    assert text.count("intended-fail") == 0

    canvas.force_draw()  # prints traceback
    canvas.force_draw()  # prints short logs ...
    canvas.force_draw()
    canvas.force_draw()

    text = caplog.text
    assert text.count("bar_method") == 2  # one traceback => 2 mentions
    assert text.count("foo_method") == 2
    assert text.count("call-failed-but-test-passed") == 4

    assert text.count("spam_method") == 2
    assert text.count("intended-fail") == 4


class MyOffscreenCanvas(rendercanvas.BaseRenderCanvas):
    def __init__(self):
        super().__init__()
        self.frame_count = 0
        self._size_info.set_physical_size(100, 100, 1)

    def _rc_get_present_info(self, present_methods):
        return {
            "method": "bitmap",
            "formats": ["rgba-u8"],
        }

    def _rc_present_bitmap(self, *, data, format, **kwargs):
        self.frame_count += 1
        self.array = np.frombuffer(data, np.uint8).reshape(data.shape)


@mark.skipif(not can_use_wgpu_lib, reason="Needs wgpu lib")
def test_run_bare_canvas():
    """Test that a bare canvas does not error."""

    # This is (more or less) the equivalent of:
    #
    #     from rendercanvas.auto import RenderCanvas, loop
    #     canvas = RenderCanvas()
    #     loop.run()
    #
    # Note: loop.run() calls _time_to_draw() in event loop.

    canvas = MyOffscreenCanvas()
    canvas.force_draw()


@mark.skipif(not can_use_wgpu_lib, reason="Needs wgpu lib")
def test_simple_offscreen_canvas():
    import wgpu

    canvas = MyOffscreenCanvas()
    device = wgpu.gpu.request_adapter_sync().request_device_sync()
    present_context = canvas.get_context("wgpu")
    present_context.configure(device=device, format=None)

    def draw_frame():
        # Note: we deliberately obtain the texture, and only create the view
        # where the dict is constructed below. This covers the case where
        # begin_render_pass() has to prevent the texture-view-object from being
        # deleted before its native handle is passed to wgpu-native.
        current_texture = present_context.get_current_texture()
        command_encoder = device.create_command_encoder()
        render_pass = command_encoder.begin_render_pass(
            color_attachments=[
                {
                    "view": current_texture.create_view(),
                    "resolve_target": None,
                    "clear_value": (0, 1, 0, 1),
                    "load_op": wgpu.LoadOp.clear,
                    "store_op": wgpu.StoreOp.store,
                }
            ],
        )
        render_pass.end()
        device.queue.submit([command_encoder.finish()])

    assert canvas.frame_count == 0

    canvas.request_draw(draw_frame)

    # Draw 1
    canvas.force_draw()
    assert canvas.array.shape == (100, 100, 4)
    assert np.all(canvas.array[:, :, 0] == 0)
    assert np.all(canvas.array[:, :, 1] == 255)

    # Draw 2
    canvas.force_draw()
    assert canvas.array.shape == (100, 100, 4)
    assert np.all(canvas.array[:, :, 0] == 0)
    assert np.all(canvas.array[:, :, 1] == 255)

    # Change resolution
    canvas._size_info.set_physical_size(120, 100, 1)

    # Draw 3
    canvas.force_draw()
    assert canvas.array.shape == (100, 120, 4)
    assert np.all(canvas.array[:, :, 0] == 0)
    assert np.all(canvas.array[:, :, 1] == 255)

    # Change resolution
    canvas._size_info.set_physical_size(120, 140, 1)

    # Draw 4
    canvas.force_draw()
    assert canvas.array.shape == (140, 120, 4)
    assert np.all(canvas.array[:, :, 0] == 0)
    assert np.all(canvas.array[:, :, 1] == 255)

    # We now have four unique texture objects
    assert canvas.frame_count == 4


def test_canvas_base_events():
    c = rendercanvas.BaseRenderCanvas()

    # We test events extensively in another test module. This is just
    # to make sure that events are working for the base canvas.

    events = []

    def handler(event):
        events.append(event["value"])

    c.add_event_handler(handler, "key_down")
    c.submit_event({"event_type": "key_down", "value": 1})
    c.submit_event({"event_type": "key_down", "value": 2})

    c._events.flush()
    assert events == [1, 2]


# ==================== closing


class CanvasThatLogsClose(rendercanvas.base.BaseRenderCanvas):
    _rc_canvas_group = SomeCanvasGroup(None)

    def __init__(self, *, fail_close=False, fail_context_close=False):
        super().__init__()
        self._fail_close = fail_close
        self._fail_context_close = fail_context_close
        self.close_count = 0
        self._present_to_screen = False
        self._canvas_context = ClosingStubContext(fail_context_close)

    def _draw_frame(self):
        pass

    def _rc_close(self):
        self.close_count += 1
        if self._fail_close:
            raise Exception("rc-close-failed")


class ClosingStubContext:
    def __init__(self, fail=False):
        self._fail = fail
        self.close_count = 0

    def _rc_present(self, force_sync=False):
        return {"method": "skip"}

    def _rc_close(self):
        self.close_count += 1
        if self._fail:
            raise Exception("context-close-failed")


def test_canvas_close_emits_close_once():
    canvas = CanvasThatLogsClose()

    events = []
    canvas.add_event_handler(lambda ev: events.append(ev["event_type"]), "close")

    canvas.close()
    assert canvas.get_closed()
    assert events == ["close"]
    assert canvas.close_count == 1
    assert canvas._canvas_context is None
    assert canvas._events._closed

    # Closing again does not raise, does not emit the close event again,
    # and does not close the native canvas again.
    canvas.close()
    assert events == ["close"]
    assert canvas.close_count == 1

    # Drawing and scheduling after close are safe no-ops.
    canvas.force_draw()
    canvas.request_draw()
    canvas.set_update_mode("continuous")
    assert canvas.close_count == 1


def test_canvas_close_drops_pending_events():
    canvas = CanvasThatLogsClose()

    received = []
    canvas.add_event_handler(
        lambda ev: received.append(ev["event_type"]), "key_down", "close"
    )
    canvas.submit_event({"event_type": "key_down", "key": "A"})

    canvas.close()
    assert received == ["close"]

    # Submitting after close is silently ignored.
    canvas.submit_event({"event_type": "key_down", "key": "B"})
    canvas._events.flush()
    assert received == ["close"]


def test_canvas_close_ignores_new_handlers():
    canvas = CanvasThatLogsClose()
    canvas.close()

    received = []
    canvas.add_event_handler(lambda ev: received.append(ev), "close", "key_down")
    canvas.submit_event({"event_type": "key_down", "key": "A"})
    canvas._events.flush()
    assert received == []


def test_canvas_close_from_within_draw():
    canvas = CanvasThatLogsClose()

    def draw_frame():
        canvas.close()

    canvas.request_draw(draw_frame)
    canvas.force_draw()  # Must not raise, and must not present after closing.

    assert canvas.get_closed()
    assert canvas.close_count == 1


def test_canvas_close_from_within_before_draw():
    canvas = CanvasThatLogsClose()
    drawn = []

    def on_before_draw(event):
        if not canvas.get_closed():
            canvas.close()

    canvas.add_event_handler(on_before_draw, "before_draw")
    canvas.request_draw(lambda: drawn.append(True))
    canvas.force_draw()  # Must not raise, and must not draw after closing.

    assert canvas.get_closed()
    assert drawn == []
    assert canvas.close_count == 1


def test_canvas_close_raises_first_error_but_finishes_closing():
    canvas = CanvasThatLogsClose(fail_close=True, fail_context_close=True)

    received = []
    canvas.add_event_handler(lambda ev: received.append(ev["event_type"]), "close")

    with pytest.raises(Exception) as err:
        canvas.close()

    assert "rc-close-failed" in str(err.value)
    # The event system was still closed properly, and close was emitted once.
    assert received == ["close"]
    assert canvas._events._closed
    assert canvas._canvas_context is None

    # A subsequent call is a no-op and does not raise again.
    canvas.close()
    assert received == ["close"]


if __name__ == "__main__":
    run_tests(globals())
