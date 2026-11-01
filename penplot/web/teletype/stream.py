"""Append-only line streamer on top of the MachineService's controller.

Same character-counting flow control as the core Sender, but open-ended:
lines can be appended at any time, each may carry a tag that is reported
when its reply arrives. Writes go through controller.send() (write lock);
no own serial port.
"""
import collections
import threading


class Streamer:
    def __init__(self, ctrl, on_ack=None, on_error=None):
        self.c = ctrl
        self.on_ack = on_ack or (lambda tag: None)
        self.on_error = on_error or (lambda cmd, reply: None)
        self.q = collections.deque()          # (line, tag)
        self.inflight = collections.deque()   # (nbytes, tag, line)
        self._lock = threading.RLock()
        self.cap = ctrl.RX_CAPACITY if ctrl.RX_CAPACITY > 0 else 1
        self.sent = 0
        self.acked = 0
        self.errors = 0
        self.lost = None
        self.closed = False
        ctrl.add_event_listener(self._event)

    def close(self):
        self.closed = True
        self.c.remove_event_listener(self._event)

    def pending(self):
        with self._lock:
            return len(self.q) + len(self.inflight)

    def queue(self, lines, tag=None):
        """Append lines; the tag is attached to the LAST line. Every line goes
        through the core sanitizer (P1): comments stripped, realtime/non-ASCII
        bytes and $ commands refused."""
        from ...machine.base import sanitize_line
        lines = [sanitize_line(ln, 'teletype', allow_dollar=False) for ln in lines]
        with self._lock:
            lines = [ln for ln in lines if ln]
            for i, ln in enumerate(lines):
                self.q.append((ln, tag if i == len(lines) - 1 else None))
        self._fill()

    def flush(self):
        """Drop everything not yet sent (and forget in-flight lines);
        returns the tags that will never be acked."""
        with self._lock:
            tags = [t for _, t in self.q if t is not None] + [t for _, t, _ in self.inflight if t is not None]
            self.q.clear()
            self.inflight.clear()
            return tags

    def _fill(self):
        with self._lock:
            if self.closed or self.lost:
                return
            while self.q:
                line, tag = self.q[0]
                need = len(line) + 1
                if self.inflight and sum(n for n, _, _ in self.inflight) + need > self.cap:
                    break
                if self.c.RX_CAPACITY == -1 and self.inflight:
                    break
                self.q.popleft()
                try:
                    self.c.send(line, False)
                except Exception:
                    self.q.appendleft((line, tag))
                    return
                self.inflight.append((need, tag, line))
                self.sent += 1

    def _event(self, ev):
        if ev.type == 'ok' or (ev.type == 'error' and self.c.ERROR_IS_RESPONSE):
            with self._lock:
                if not self.inflight:
                    return              # a manual command's reply, or after a flush
                item = self.inflight.popleft()
                self.acked += 1
            if ev.type == 'error':
                self.errors += 1
                self.on_error(item[2] if item else None, ev.data)
            if item and item[1] is not None:
                self.on_ack(item[1])
            self._fill()
        elif ev.type == 'disconnected':
            self.lost = ev.data or 'disconnected'
