"""
The event system.
"""

import time
from collections import defaultdict, deque
from inspect import iscoroutinefunction
from typing import Callable

from .coreutils import log_exception
from .enums import EventType

valid_event_types = set(EventType)


class EventEmitter:
    """The EventEmitter stores event handlers, collects incoming events, and dispatched them.

    Subsequent events of ``event_type`` 'pointer_move' and 'wheel' are merged.
    """

    _EVENTS_THAT_MERGE = {
        "pointer_move": {
            "match_keys": {"buttons", "modifiers", "ntouches"},
            "accum_keys": {},
        },
        "wheel": {
            "match_keys": {"modifiers"},
            "accum_keys": {"dx", "dy"},
        },
        "resize": {
            "match_keys": {},
            "accum_keys": {},
        },
    }

    def __init__(self):
        self._pending_events = deque()
        self._event_handlers = defaultdict(list)
        self._closed = False

    def _release(self):
        self._closed = True
        self._pending_events.clear()
        self._event_handlers.clear()

    def add_handler(self, *args, order: float = 0) -> Callable:
        """Register an event handler to receive events.

        Arguments:
            callback (callable, optional): The event handler. Must accept a single event argument.
            *types (list of EventType): A list of event types.
            order (float): Set callback priority order. Callbacks with lower priorities
                are called first. Default is 0. When an event is emitted, callbacks with
                the same priority are called in the order that they were added.

        For the available events, see
        https://jupyter-rfb.readthedocs.io/en/stable/events.html.

        The callback is stored, so it can be a lambda or closure. This also
        means that if a method is given, a reference to the object is held,
        which may cause circular references or prevent the Python GC from
        destroying that object.

        Example:

        .. code-block:: py

            def my_handler(event):
                print(event)

            canvas.add_event_handler(my_handler, "pointer_up", "pointer_down")

        Can also be used as a decorator:

        .. code-block:: py

            @canvas.add_event_handler("pointer_up", "pointer_down")
            def my_handler(event):
                print(event)

        Catch 'm all:

        .. code-block:: py

            canvas.add_event_handler(my_handler, "*")

        """
        order = float(order)
        callback = None
        types = args
        if len(args) > 0 and callable(args[0]):
            callback = args[0]
            types = args[1:]

        if not types:
            raise TypeError("No event types are given to add_event_handler.")
        for type in types:
            if not isinstance(type, str):
                raise TypeError(f"Event types must be str, but got {type}")
            if not (type == "*" or type in valid_event_types):
                raise ValueError(f"Adding handler with invalid event_type: '{type}'")

        def decorator(_callback: Callable):
            self._add_handler(_callback, order, *types)
            return _callback

        if callback is None:
            return decorator
        return decorator(callback)

    def _add_handler(self, callback, order, *types):
        if iscoroutinefunction(callback):
            raise TypeError(
                "Coroutines cannot be callbacks (anymore). Instead, you can use a regular callback that calls `loop.add_task(coro)`."
            )
        if self._closed:
            return
        self.remove_handler(callback, *types)
        for type in types:
            self._event_handlers[type].append((order, callback))
            self._event_handlers[type].sort(key=lambda x: x[0])
            # Note: that sort is potentially expensive. I tried an approach with a custom dequeu to add the handler
            # at the correct position, but the overhead was apparently larger than the benefit of avoiding sort.
            # TODO: bisect.insort could help

    def remove_handler(self, callback, *types):
        """Unregister an event handler.

        Arguments:
            callback (callable): The event handler.
            *types (list of strings): A list of event types.
        """
        for type in types:
            self._event_handlers[type] = [
                (o, cb) for o, cb in self._event_handlers[type] if cb != callback
            ]

    def submit(self, event):
        """Submit an event.

        Events are emitted later by the scheduler.
        """
        if self._closed:
            return
        event_type = event["event_type"]
        if event_type not in valid_event_types:
            raise ValueError(f"Submitting with invalid event_type: '{event_type}'")

        event.setdefault("time_stamp", time.perf_counter())
        event_merge_info = self._EVENTS_THAT_MERGE.get(event_type, None)

        if event_merge_info and self._pending_events:
            # Try merging the event with the last one
            last_event = self._pending_events[-1]
            if last_event["event_type"] == event_type:
                match_keys = event_merge_info["match_keys"]
                accum_keys = event_merge_info["accum_keys"]
                if all(
                    event.get(key, None) == last_event.get(key, None)
                    for key in match_keys
                ):
                    # Merge-able event
                    self._pending_events.pop()  # remove last_event
                    # Update new event
                    for key in accum_keys:
                        event[key] += last_event.get(key, 0)

        self._pending_events.append(event)

    def flush(self):
        """Dispatch all pending events.

        This should generally be left to the scheduler.
        """
        while True:
            try:
                event = self._pending_events.popleft()
            except IndexError:
                break
            self.emit(event)

    def emit(self, event):
        """Directly emit the given event.

        In most cases events should be submitted, so that they are flushed
        with the rest at a good time.
        """
        # Collect callbacks
        # Note that the 'anytype' (*) handlers are always fired later. Fixing it would require sorting here, which I don't want to do for performance.
        # A better solution is probably to simply add an entry for every type in add_handler, so self._event_handlers["*"] would not exist.
        # For now leaving this 'bug' for what it is, maybe fix when we refactor events.
        event_type = event.get("event_type")
        callbacks = self._event_handlers[event_type] + self._event_handlers["*"]
        # Dispatch
        for _order, callback in callbacks:
            if event.get("stop_propagation", False):
                break
            with log_exception(f"Error during handling {event_type} event"):
                callback(event)
        # Close?
        if event_type == "close":
            self._release()

    def close(self):
        """Close the event handler.

        Drops all pending events, sends the close event to the handlers that
        are registered at this moment, and then disables the emitter.

        The close event is emitted *before* the handlers are released, so
        registered handlers always receive it. Calling this method more than
        once is a no-op: the close event is emitted exactly once.

        Any events that were submitted but not yet flushed are dropped: they
        do not reach any handler. After closing, ``submit()`` silently ignores
        events, and handlers registered afterwards are never called.
        """
        # This is a little feature because detecting a widget from closing can be tricky.
        if self._closed:
            return

        # Mark as closed first: this makes submit() and add_handler() no-ops
        # while the close event is being dispatched, and makes re-entrant or
        # repeated calls to close() harmless.
        self._closed = True

        # Drop events that were pending (submitted but not flushed): after
        # closing they must not trigger any handler.
        self._pending_events.clear()

        # Notify the currently registered handlers. Note that emit() does not
        # check _closed, and that it snapshots the callbacks before calling
        # them, so (de)registering handlers from within a handler is safe.
        # We bypass submit() (which is a no-op now) but keep its time_stamp
        # convention, so the close event looks like any other submitted event.
        close_event = {"event_type": "close", "time_stamp": time.perf_counter()}
        self.emit(close_event)

        # Release the handlers and any (newly submitted) pending events.
        # Note that emit() already calls _release() for the close event, but
        # doing it here too makes this method robust and explicit.
        self._release()
