"""EventBus: fan-out to WS clients without ever blocking producers (03 §2.6).

Each subscriber has latest-value slots (status/progress/system: overwritten)
and a bounded deque for discrete events. On overflow the oldest `log`
entries go first, then the oldest anything; the client gets a `gap` marker.
"""
import asyncio
import collections
import functools
import itertools
import logging
import threading
import time

log = logging.getLogger('penplot.web.events')

LATEST = ('status', 'progress', 'system')
DEFAULT_TOPICS = {'status', 'progress', 'job', 'alarm', 'task', 'system', 'error', 'notice',
                  'presence', 'lease', 'project', 'locks', 'teletype', 'attention'}
ALL_TOPICS = DEFAULT_TOPICS | {'log'}
MAXQ = 256


class Subscriber:
    _ids = itertools.count(1)

    def __init__(self, topics=None):
        self.id = 'c%d' % next(self._ids)
        self.topics = set(topics or DEFAULT_TOPICS)
        self.slots = {}
        self.queue = collections.deque()
        self.dropped = 0
        self.wake = asyncio.Event()
        self.closed = False
        self.user = None          # {id, username, display_name, role}
        self.page = None
        self.project_id = None
        self.element_id = None
        self.client = None
        self.since = time.time()

    def offer(self, msg):
        t = msg['type']
        if '_project' in msg and msg['_project'] != self.project_id:
            return
        topic = msg.get('_topic', t)
        if topic not in self.topics and t not in ('notice', 'gap', 'ack', 'hello', 'pong'):
            return
        if t in LATEST:
            self.slots[t] = msg
        else:
            if len(self.queue) >= MAXQ:
                # drop the oldest log batch if any, else the oldest message
                for i, m in enumerate(self.queue):
                    if m['type'] == 'log':
                        del self.queue[i]
                        break
                else:
                    self.queue.popleft()
                self.dropped += 1
            self.queue.append(msg)
        self.wake.set()

    def drain(self):
        out = []
        if self.dropped:
            out.append({'type': 'gap', 'dropped': self.dropped})
            self.dropped = 0
        out.extend(self.queue)
        self.queue.clear()
        for k in LATEST:
            m = self.slots.pop(k, None)
            if m is not None:
                out.append(m)
        self.wake.clear()
        return out


class EventBus:
    def __init__(self):
        self.subs = set()
        self.loop = None
        self._log_buf = collections.deque(maxlen=2000)
        self._log_dropped = 0
        self._log_lock = threading.Lock()
        self._task = None
        self.listeners = []          # in-process callbacks fn(msg) (tests, job runner)

    def bind(self, loop):
        self.loop = loop

    def start(self):
        self.loop = asyncio.get_running_loop()
        self._task = asyncio.create_task(self._log_flusher())

    async def stop(self):
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):
                pass

    def subscribe(self, topics=None):
        s = Subscriber(topics)
        self.subs.add(s)
        return s

    def unsubscribe(self, s):
        s.closed = True
        self.subs.discard(s)

    # -- producers ------------------------------------------------------
    def publish(self, type_, data=None, topic=None, **extra):
        """Call from the event loop thread."""
        msg = {'type': type_}
        if data is not None:
            msg['data'] = data
        msg.update(extra)
        if topic:
            msg['_topic'] = topic
        for s in list(self.subs):
            s.offer(msg)
        for fn in list(self.listeners):
            try:
                fn(msg)
            except Exception:
                log.exception('bus listener')

    def publish_threadsafe(self, type_, data=None, topic=None, **extra):
        loop = self.loop
        if loop is None or loop.is_closed():
            return
        try:
            if _running_loop() is loop:
                self.publish(type_, data, topic, **extra)
            else:
                loop.call_soon_threadsafe(functools.partial(self.publish, type_, data, topic, **extra))
        except RuntimeError:
            pass

    def log_line(self, direction, text):
        """O(1), any thread. Batched every 200 ms to clients subscribed to `log`."""
        with self._log_lock:
            if len(self._log_buf) == self._log_buf.maxlen:
                self._log_dropped += 1
            self._log_buf.append({'t': time.time(), 'dir': direction, 'text': text})

    async def _log_flusher(self):
        while True:
            await asyncio.sleep(0.2)
            with self._log_lock:
                if not self._log_buf:
                    continue
                lines = list(self._log_buf)
                self._log_buf.clear()
                dropped, self._log_dropped = self._log_dropped, 0
            if any('log' in s.topics for s in self.subs):
                self.publish('log', {'lines': lines, 'dropped': dropped})


def _running_loop():
    try:
        return asyncio.get_running_loop()
    except RuntimeError:
        return None
