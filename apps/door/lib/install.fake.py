"""A pretend Wedgie for install.test.ts, on stdin and stdout: wedgie firmware's JSON lines (hello, chip, open, stop),
then MicroPython's raw REPL as a computer with full control sees it, run by CPython with a folder as its flash. The
Console's own Python (repl.ts) runs in it as it would on the Wedgie, but FREE_PY, which only frees a real board's RAM.

  python3 -I install.fake.py <flash folder> [old] [atecc] [chipless] [refuse] [saidno] [stay] [full] [corrupt] [noraw]

  old: firmware 0.3.30. atecc: an ATECC608, not a Trust M. chipless: hello hasn't asked its chip yet.
  refuse: red on FULL CONTROL?. saidno: it said no before, so it doesn't ask. stay: its restart keeps the port
  (else the restart after full control is a real reset, and it goes). full: 20 KB free. corrupt: a written byte flips.
  noraw: Ctrl-C gives no REPL, even after a yes.
What its screen showed goes in <flash folder>.screen, one line a drawing.
"""
import binascii
import contextlib
import io
import json
import os
import re
import sys
import traceback

root, opts = os.path.abspath(sys.argv[1]), set(sys.argv[2:])
screen = root + ".screen"
os.chdir(root)
out = sys.stdout.buffer


def send(b):
    out.write(b.encode() if isinstance(b, str) else b)
    out.flush()


def drew(what):
    with open(screen, "a") as f:
        f.write(what + "\n")


class LCD:
    """The firmware's lcd, for BUSY_PY: what it would draw, as text"""

    def fill(self, c):
        pass

    def fill_rect(self, *a):
        pass

    def rect(self, *a):
        pass

    def center_text(self, t, *a):
        drew(t)

    def show(self):
        pass


lcd = type(sys)("lcd")
lcd.LCD = LCD
lcd.color = lambda r, g, b: 0
sys.modules["lcd"] = lcd
if "full" in opts:
    os.statvfs = lambda p: (4096, 4096, 1000, 5, 5)
if "corrupt" in opts:
    real = binascii.a2b_base64
    flipped = [False]

    def a2b(s):
        b = bytearray(real(s))
        if b and not flipped[0]:
            b[0] ^= 1
            flipped[0] = True
        return bytes(b)

    binascii.a2b_base64 = a2b


def running():
    """The app apps.json names, as the firmware's hello says it: its mod, and Knock's FW"""
    try:
        a = json.load(open("apps.json"))[0]
    except Exception:
        return None, None
    mod = a.get("mod")
    fw = None
    if mod == "knock" and os.path.exists("knock.py"):
        m = re.search(r'FW = "([^"]+)"', open("knock.py").read())
        fw = m and m.group(1)
    return mod, fw


opened = False
mode = "app"        # app: JSON lines; repl: the friendly REPL; raw: the raw REPL
line, code, ns = b"", b"", {}


def hello(mid):
    mod, fw = running()
    h = {"type": "hello", "fw": "wedgie-" + ("0.3.30" if "old" in opts else "0.3.77"),
         "version": "0.3.30" if "old" in opts else "0.3.77", "sealed": True, "open": opened, "running": mod,
         "chip": None if "chipless" in opts else "ATECC608" if "atecc" in opts else "OPTIGA Trust M"}
    if fw:
        h["app"] = fw
    if mid is not None:
        h["id"] = mid
    return h


def answer(m):
    global opened
    mid, t = m.get("id"), m.get("type")
    if t == "hello":
        r = hello(mid)
    elif t == "chip":
        r = {"id": mid, "type": "chip", "kind": "atecc" if "atecc" in opts else "trustm"}
    elif t == "open":
        drew("FULL CONTROL? (%s)" % m.get("for"))
        if "saidno" in opts:
            r = {"id": mid, "type": "refused", "asked_ms": None}
        elif "refuse" in opts:
            r = {"id": mid, "type": "refused", "asked_ms": 1500}
        else:
            opened = True
            r = {"id": mid, "type": "open", "asked_ms": 1500}
    elif t == "stop":
        r = {"id": mid, "type": "ok"}
    else:
        r = {"id": mid, "type": "error", "error": "unknown type"}
    send(json.dumps(r) + "\n")


def run(src):
    """One raw REPL run: OK, its output, 0x04, its error, 0x04, the prompt"""
    send("OK")
    if "def _free():" in src:
        send("\x04\x04>")
        return
    o = io.StringIO()
    err = ""
    try:
        with contextlib.redirect_stdout(o):
            exec(src, ns)
    except Exception as e:
        err = "Traceback (most recent call last):\r\n" + "".join(traceback.format_exception_only(type(e), e))
    send(o.getvalue().replace("\n", "\r\n") + "\x04" + err + "\x04>")


def restart():
    """After full control, a soft reset is a real one (boot.py): the port goes, unless stay"""
    global opened, mode, ns
    if "stay" not in opts:
        sys.exit(0)
    opened, mode, ns = False, "app", {}
    send(json.dumps(hello(None) | {"type": "ready"}) + "\n")


while True:
    chunk = os.read(0, 4096)
    if not chunk:
        break
    for b in chunk:
        c = bytes([b])
        if mode == "app":
            if c == b"\x03":
                if opened and "noraw" not in opts:     # Ctrl-C works once its person said yes
                    mode = "repl"
                    send("\r\nKeyboardInterrupt: \r\nMicroPython v1.29.0\r\n>>> ")
            elif c == b"\n":
                try:
                    answer(json.loads(line))
                except ValueError:
                    pass
                line = b""
            else:
                line += c
        elif mode == "repl":
            if c == b"\x01":
                mode, code = "raw", b""
                send("\r\nraw REPL; CTRL-B to exit\r\n>")
            elif c == b"\x04":
                restart()
            elif c == b"\x03":
                send("\r\n>>> ")
        elif mode == "raw":
            if c == b"\x04":
                if code:
                    run(code.decode())
                    code = b""
                else:
                    restart()
            elif c == b"\x02":
                mode = "repl"
                send("\r\nMicroPython v1.29.0\r\n>>> ")
            else:
                code += c
