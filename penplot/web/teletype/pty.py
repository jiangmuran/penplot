"""Interactive shell on a pseudo-terminal (terminal mode).

SECURITY: this is a shell over the web. The service only starts it when
settings.teletype.terminal_enabled is true, for admins, and audits it. If
the service runs as root and settings.teletype.terminal_user names a user,
the shell drops to that user (setgid/initgroups/setuid) before exec.
"""
import codecs
import fcntl
import logging
import os
import struct
import subprocess
import termios
import threading
import time

log = logging.getLogger('penplot.web.teletype')


def _user_info(name):
    import pwd
    try:
        return pwd.getpwnam(name)
    except KeyError:
        return None


class Pty:
    def __init__(self, on_output, cols, rows=30, user=None, shell=None):
        self.on_output = on_output
        self.cols = cols
        self.rows = rows
        self.user = user
        self.shell = shell
        self.fd = None
        self.proc = None
        self.lock = threading.Lock()
        self.stopped = False
        self.run_as = None
        self._restarts = []

    def start(self):
        master, slave = os.openpty()
        self._winsize(slave)
        env = {'TERM': 'xterm-256color', 'LANG': os.environ.get('LANG', 'C.UTF-8'),
               'PATH': '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
               'COLUMNS': str(self.cols), 'LINES': str(self.rows)}
        import pwd
        pw = pwd.getpwuid(os.getuid())
        target = None
        if self.user and os.getuid() == 0:
            target = _user_info(self.user)
            if target is None:
                log.warning('terminal_user %r not found, using %s', self.user, pw.pw_name)
        who = target or pw
        home = who.pw_dir if os.path.isdir(who.pw_dir) else '/tmp'
        env.update(HOME=home, USER=who.pw_name, LOGNAME=who.pw_name)
        shell = self.shell or (who.pw_shell if who.pw_shell and 'nologin' not in who.pw_shell
                               and 'false' not in who.pw_shell else '/bin/bash')
        env['SHELL'] = shell
        self.run_as = who.pw_name

        # P22: no preexec_fn in a threaded process. A tiny exec wrapper makes the
        # slave the controlling tty (os.login_tty); Popen(user=...) drops privileges.
        import sys
        wrapper = 'import os,sys;os.login_tty(0);os.execvp(sys.argv[1],sys.argv[1:])'
        kw = {}
        if target is not None:
            kw = dict(user=target.pw_uid, group=target.pw_gid, extra_groups=[])
        self.proc = subprocess.Popen([sys.executable, '-I', '-c', wrapper, shell, '-l'], stdin=slave, stdout=slave,
                                     stderr=slave, cwd=home, env=env, close_fds=True, **kw)
        os.close(slave)
        self.fd = master
        threading.Thread(target=self._reader, args=(master, self.proc), daemon=True).start()

    def _winsize(self, fd):
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', self.rows, self.cols, 0, 0))

    def resize(self, cols=None, rows=None):
        if cols:
            self.cols = int(cols)
        if rows:
            self.rows = max(5, min(200, int(rows)))
        if self.fd is not None:
            try:
                self._winsize(self.fd)
            except OSError:
                pass

    def write(self, data):
        if self.fd is None:
            return
        b = data.encode('utf-8') if isinstance(data, str) else bytes(data)
        with self.lock:
            while b:
                n = os.write(self.fd, b)
                b = b[n:]

    def stop(self):
        self.stopped = True
        if self.proc and self.proc.poll() is None:
            try:
                os.killpg(self.proc.pid, 15)
            except OSError:
                pass

    def _reader(self, fd, proc):
        dec = codecs.getincrementaldecoder('utf-8')('replace')
        while True:
            try:
                data = os.read(fd, 4096)
            except OSError:
                data = b''
            if not data:
                break
            self.on_output(dec.decode(data))
        proc.wait()
        try:
            os.close(fd)
        except OSError:
            pass
        self.fd = None
        if self.stopped:
            return
        now = time.time()
        self._restarts = [t for t in self._restarts if now - t < 60] + [now]
        if len(self._restarts) > 5:
            self.on_output('\r\n[shell exited %s; too many restarts, giving up]\r\n' % proc.returncode)
            return
        delay = 2 ** (len(self._restarts) - 1)
        self.on_output('\r\n[shell exited %s, restarting in %d s]\r\n' % (proc.returncode, delay))
        time.sleep(delay)
        if not self.stopped:
            self.start()
