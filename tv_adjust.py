"""
TradingView-assisted price correction for corporate actions NSE gives no ratio for
(demergers, etc.) - see the Data Quality tab's "Recent Corporate Actions Not
Price-Adjusted" section.

TradingView already carries demerger-adjusted history for most of these, so instead
of guessing a ratio we read TradingView's daily bars for the stock and compare them
with the dashboard's own prices around the ex-date. Everything before the ex-date
differs by one constant factor; that factor is what gets stored and applied.

This module is stdlib-only (no websocket library needed) and does NOTHING on import:
the server only touches TradingView when the user clicks the button in the Data
Quality tab. TradingView Desktop must be running with its DevTools port open:

    TradingView.exe --remote-debugging-port=9222
"""

import base64
import json
import os
import re
import socket
import struct
import urllib.request
from datetime import datetime, timedelta, timezone
from statistics import median
from urllib.parse import urlparse

DEFAULT_CDP_PORT = 9222
IST = timezone(timedelta(hours=5, minutes=30))


class TradingViewError(Exception):
    """Anything that stops us reading TradingView (not running, symbol not found, ...)."""


class TradingViewConnectionError(TradingViewError):
    """The DevTools connection itself failed or dropped - no point trying further symbols."""


# ── Minimal WebSocket client for the Chrome DevTools Protocol ────────────────
class _CDPConnection:
    """Just enough RFC 6455 for CDP on localhost: one text-frame request/response at a
    time, fragmentation and ping/pong handled, no TLS, no compression."""

    def __init__(self, ws_url, timeout=30):
        u = urlparse(ws_url)
        self._sock = socket.create_connection((u.hostname, u.port), timeout=timeout)
        self._sock.settimeout(timeout)
        key = base64.b64encode(os.urandom(16)).decode()
        self._sock.sendall((
            f"GET {u.path} HTTP/1.1\r\nHost: {u.hostname}:{u.port}\r\nUpgrade: websocket\r\n"
            f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n"
        ).encode())
        buf = b''
        while b'\r\n\r\n' not in buf:
            chunk = self._sock.recv(4096)
            if not chunk:
                raise TradingViewConnectionError('DevTools handshake failed: connection closed')
            buf += chunk
        head, self._rest = buf.split(b'\r\n\r\n', 1)
        if b' 101 ' not in head.split(b'\r\n')[0]:
            raise TradingViewConnectionError('DevTools handshake refused: ' + head.decode(errors='replace')[:120])
        self._next_id = 0

    def _read(self, n):
        while len(self._rest) < n:
            chunk = self._sock.recv(65536)
            if not chunk:
                raise TradingViewConnectionError('DevTools connection closed')
            self._rest += chunk
        out, self._rest = self._rest[:n], self._rest[n:]
        return out

    def _send_frame(self, opcode, data):
        n = len(data)
        hdr = bytearray([0x80 | opcode])
        if n < 126:
            hdr.append(0x80 | n)
        elif n < 65536:
            hdr.append(0x80 | 126)
            hdr += struct.pack('>H', n)
        else:
            hdr.append(0x80 | 127)
            hdr += struct.pack('>Q', n)
        mask = os.urandom(4)
        hdr += mask
        self._sock.sendall(bytes(hdr) + bytes(b ^ mask[i % 4] for i, b in enumerate(data)))

    def _recv_message(self):
        payload = b''
        while True:
            b0, b1 = self._read(2)
            fin, opcode = b0 & 0x80, b0 & 0x0F
            n = b1 & 0x7F
            if n == 126:
                n = struct.unpack('>H', self._read(2))[0]
            elif n == 127:
                n = struct.unpack('>Q', self._read(8))[0]
            data = self._read(n)
            if opcode == 0x9:                     # ping -> pong
                self._send_frame(0xA, data)
                continue
            if opcode == 0xA:                     # unsolicited pong
                continue
            if opcode == 0x8:
                raise TradingViewConnectionError('DevTools connection closed by TradingView')
            payload += data
            if fin:
                return payload.decode()

    def call(self, method, params=None):
        self._next_id += 1
        mid = self._next_id
        self._send_frame(0x1, json.dumps({'id': mid, 'method': method, 'params': params or {}}).encode())
        while True:
            msg = json.loads(self._recv_message())
            if msg.get('id') == mid:
                if 'error' in msg:
                    raise TradingViewError(f"{method}: {msg['error'].get('message', msg['error'])}")
                return msg['result']

    def evaluate(self, expression):
        r = self.call('Runtime.evaluate', {
            'expression': expression, 'returnByValue': True, 'awaitPromise': True})
        if 'exceptionDetails' in r:
            ex = r['exceptionDetails']
            text = (ex.get('exception') or {}).get('description') or ex.get('text') or 'script error'
            raise TradingViewError(text.split('\n')[0])
        return r['result'].get('value')

    def close(self):
        try:
            self._sock.close()
        except OSError:
            pass


# ── Page-side scripts (run inside TradingView's chart page) ──────────────────
_JS_STATE = """(() => {
  const w = window.TradingViewApi._activeChartWidgetWV.value();
  return { symbol: w.symbol(), resolution: w.resolution() };
})()"""

# Switch the chart to `sym` on the daily resolution, wait until the series has loaded
# for exactly that symbol, then return [[unixSeconds, close], ...] for every loaded bar.
# TradingView only loads ~300 daily bars up front, so if `needFrom` (unix seconds, 0 = don't
# care) is older than the first loaded bar, keep calling requestMoreData() (300 bars a call)
# until the history reaches back far enough or runs out.
_JS_LOAD_BARS = """(async (sym, resolution, timeoutMs, needFrom) => {
  const w = window.TradingViewApi._activeChartWidgetWV.value();
  const ms = w.chartModel().mainSeries();
  if (w.resolution() !== resolution) w.setResolution(resolution);
  if (w.symbol() !== sym) w.setSymbol(sym);
  const t0 = Date.now();
  for (;;) {
    await new Promise(r => setTimeout(r, 150));
    if (Date.now() - t0 > timeoutMs) throw new Error('timed out waiting for ' + sym + ' to load');
    if (ms.isSymbolInvalid && ms.isSymbolInvalid()) throw new Error(sym + ' not found on TradingView');
    if (ms.isStatusError && ms.isStatusError()) throw new Error('TradingView error loading ' + sym);
    const si = ms.symbolInfo();
    if (!si || w.symbol() !== sym || w.resolution() !== resolution || ms.interval() !== resolution) continue;
    if (ms.isLoading()) continue;
    const bars = ms.bars();
    if (bars.size() === 0) continue;
    // Settle: two identical size readings in a row, so a still-arriving history
    // chunk doesn't get read half-way.
    const s1 = bars.size();
    await new Promise(r => setTimeout(r, 250));
    if (ms.isLoading() || bars.size() !== s1) continue;
    for (let round = 0; needFrom > 0 && round < 6 && bars.valueAt(bars.firstIndex())[0] > needFrom
                        && ms.requestMoreDataAvailable(); round++) {
      const before = bars.size();
      ms.requestMoreData(300);
      const t1 = Date.now();
      while (Date.now() - t1 < 10000) {
        await new Promise(r => setTimeout(r, 150));
        if (bars.size() > before && !ms.isLoading()) break;
      }
      if (bars.size() === before) break;
    }
    const out = [];
    for (let i = bars.firstIndex(); i <= bars.lastIndex(); i++) {
      const v = bars.valueAt(i);
      if (v) out.push([v[0], v[4]]);
    }
    return { name: si.name, fullName: si.full_name, bars: out };
  }
})(%s, %s, %d, %d)"""

_JS_RESTORE = """(async (sym, resolution) => {
  const w = window.TradingViewApi._activeChartWidgetWV.value();
  if (w.resolution() !== resolution) w.setResolution(resolution);
  if (w.symbol() !== sym) w.setSymbol(sym);
  return true;
})(%s, %s)"""


def tv_symbol(nse_symbol):
    """NSE ticker -> TradingView ticker. TradingView writes '&' and '-' as '_'
    (M&M -> NSE:M_M, BAJAJ-AUTO -> NSE:BAJAJ_AUTO)."""
    return 'NSE:' + re.sub(r'[&\-]', '_', (nse_symbol or '').strip().upper())


def ist_date(unix_seconds):
    """A TradingView daily-bar timestamp -> the trading date it belongs to (IST)."""
    return datetime.fromtimestamp(unix_seconds, IST).date()


class TradingViewChart:
    """Context manager around the user's open TradingView chart. Remembers the symbol and
    resolution that were showing and puts them back on exit, so a run leaves the chart as
    it found it."""

    def __init__(self, port=DEFAULT_CDP_PORT, timeout=30):
        self.port = port
        self.timeout = timeout
        self._conn = None
        self._original = None

    def __enter__(self):
        try:
            with urllib.request.urlopen(f'http://127.0.0.1:{self.port}/json', timeout=5) as r:
                targets = json.load(r)
        except OSError:
            raise TradingViewConnectionError(
                f'TradingView is not reachable on port {self.port}. Start TradingView Desktop with '
                f'--remote-debugging-port={self.port} and keep a chart open, then try again.')
        pages = [t for t in targets if t.get('type') == 'page'
                 and 'tradingview.com/chart' in t.get('url', '') and t.get('webSocketDebuggerUrl')]
        if not pages:
            raise TradingViewError('TradingView is running but no chart is open - open a chart and try again.')
        try:
            self._conn = _CDPConnection(pages[0]['webSocketDebuggerUrl'], self.timeout)
            self._original = self._conn.evaluate(_JS_STATE)
        except (OSError, TradingViewError) as e:
            self.close()
            raise TradingViewError(f'Could not talk to the TradingView chart: {e}')
        return self

    def __exit__(self, *exc):
        self.close()
        return False

    def close(self):
        if self._conn and self._original:
            try:
                self._conn.evaluate(_JS_RESTORE % (json.dumps(self._original['symbol']),
                                                   json.dumps(self._original['resolution'])))
            except (OSError, TradingViewError):
                pass
        if self._conn:
            self._conn.close()
        self._conn = None

    def daily_closes(self, nse_symbol, since=None, load_timeout=25):
        """{date: close} for the daily bars TradingView has for `nse_symbol`, loading older
        history until it reaches back to the date `since` (or runs out)."""
        sym = tv_symbol(nse_symbol)
        need_from = int(datetime(since.year, since.month, since.day, tzinfo=IST).timestamp()) if since else 0
        try:
            res = self._conn.evaluate(_JS_LOAD_BARS % (json.dumps(sym), json.dumps('1D'), load_timeout * 1000, need_from))
        except OSError as e:
            raise TradingViewConnectionError(f'Lost connection to TradingView: {e}')
        want = sym.split(':', 1)[1]
        if (res.get('name') or '').upper() != want:
            raise TradingViewError(f"TradingView opened {res.get('fullName')} instead of {sym}")
        return {ist_date(t): c for t, c in res['bars'] if c}


# ── Deriving the correction factor ───────────────────────────────────────────
def derive_correction(tv_closes, our_closes, ex_date):
    """Compare TradingView's (adjusted) closes with the dashboard's around `ex_date`.

    Both arguments are {date: close}; `ex_date` is a date. Let r(t) = TradingView / ours.
    Before the ex-date r is one constant (the demerger factor, times whatever
    dividend-adjustment TradingView also applies); from the ex-date on it is another
    constant (dividends only, usually 1). Their ratio is the factor to multiply our
    pre-ex-date prices by. Taking the ratio at the boundary cancels any dividend
    adjustment TradingView layers on, and requiring r to be flat on each side makes a
    wrong or partial match show up as 'inconclusive' instead of a bad correction.

    Returns {'status': 'adjusted'|'tv-unadjusted'|'inconclusive', 'factor': float|None, 'note': str}.
    """
    common = sorted(set(tv_closes) & set(our_closes))
    pre = [d for d in common if d < ex_date][-3:]
    post = [d for d in common if d >= ex_date][:3]
    if len(pre) < 2 or len(post) < 2:
        return {'status': 'inconclusive', 'factor': None,
                'note': 'Not enough matching bars around the ex-date (TradingView history may not reach back that far)'}

    r_pre = [tv_closes[d] / our_closes[d] for d in pre]
    r_post = [tv_closes[d] / our_closes[d] for d in post]

    # Our prices carry 2 decimals, so cheap stocks have proportionally more rounding noise.
    tol = 0.002 + 0.01 / max(1.0, median(our_closes[d] for d in pre))
    for label, rs in (('before', r_pre), ('after', r_post)):
        spread = (max(rs) - min(rs)) / median(rs)
        if spread > tol:
            return {'status': 'inconclusive', 'factor': None,
                    'note': f'TradingView and dashboard prices do not line up {label} the ex-date '
                            f'(ratio varies by {spread * 100:.2f}%)'}

    factor = median(r_pre) / median(r_post)
    prev_close, ex_close = our_closes[pre[-1]], our_closes.get(post[0]) if post[0] == ex_date else None
    move = f' (raw ex-date move {(ex_close / prev_close - 1) * 100:+.1f}%)' if ex_close else ''

    if abs(factor - 1) <= 0.003:
        return {'status': 'tv-unadjusted', 'factor': None,
                'note': 'TradingView shows no adjustment for this event' + move}
    if not 0.02 <= factor <= 50:
        return {'status': 'inconclusive', 'factor': None,
                'note': f'Implausible factor {factor:.4f} - not applied'}
    return {'status': 'adjusted', 'factor': round(factor, 6),
            'note': f'Pre-ex-date prices scaled by {factor:.5f} to match TradingView' + move}


# ── Verifying our adjusted prices against TradingView ────────────────────────
_MONTHS = ('Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec')


def format_date(d):
    """date -> 'DD-Mon-YYYY', the dashboard's date format (English month names, no locale)."""
    return f'{d.day:02d}-{_MONTHS[d.month - 1]}-{d.year}'


def _explain_level_changes(common, ratios, our_closes, events, tolerance):
    """Say what each level change in r(t) = TradingView / ours corresponds to. `events` are our
    own adjustments as (ex_date, factor) - the factor pre-ex-date prices were multiplied by.
    Walking forward in time, a step at date d means the two sources part ways there:
      - next to one of our events and equal to that event's factor  -> TradingView is NOT
        adjusted for it (ours moved by F, theirs didn't);
      - next to one of our events but a different size              -> the two adjustments differ;
      - nowhere near any event of ours                              -> TradingView adjusts for an
        action our corporate-actions data doesn't contain (e.g. a rights issue).
    A step immediately undone on the next bar is a one-bar blip, not a level change."""
    by_date = {}
    for ex, f in events:                       # several events on one day compound
        by_date[ex] = by_date.get(ex, 1.0) * f
    steps = []
    for i in range(1, len(common)):
        s = ratios[i] / ratios[i - 1]
        if abs(s - 1) > tolerance + 0.01 / our_closes[common[i]]:
            steps.append((i, s))
    causes = []
    for k, (i, s) in enumerate(steps):
        if k + 1 < len(steps) and steps[k + 1][0] == i + 1 and abs(s * steps[k + 1][1] - 1) < 0.02:
            continue                           # start of a one-bar blip
        if k and steps[k - 1][0] == i - 1 and abs(s * steps[k - 1][1] - 1) < 0.02:
            continue                           # end of a one-bar blip
        d = common[i]
        near = [(abs((ex - d).days), ex, f) for ex, f in by_date.items() if abs((ex - d).days) <= 4]
        if near:
            _, ex, f = min(near)
            if abs(s / f - 1) < 0.05:
                causes.append(f'TradingView shows no adjustment for the {format_date(ex)} event (dashboard applied x{f:.4g})')
            else:
                # TradingView's own factor = ours x (TradingView/ours before the step) = f / s
                causes.append(f'Adjustments differ at {format_date(ex)}: dashboard x{f:.4g}, TradingView x{f / s:.4g}')
        else:
            causes.append(f'TradingView also scales prices before {format_date(d)} by x{1 / s:.4g}, which the dashboard '
                          f'has no event for (a rights issue or other action missing from the corporate-actions data?)')
    return causes[:3]


def compare_series(our_closes, tv_closes, tolerance=0.01, min_bars=20, events=None):
    """Compare our (already adjusted) daily closes with TradingView's over every date both
    have. Both arguments are {date: close}.

    A bar 'differs' when |TradingView / ours - 1| exceeds `tolerance` (1%) plus a rounding
    allowance - our adjusted prices carry 2 decimals, so cheap stocks legitimately wobble
    by more in percentage terms. Grading: 'match' (no bar differs), 'minor' (a few bars
    differ, worst under 5%) or 'major' (worst >= 5%, or 5+ bars differ - i.e. a sustained
    shift like a wrong split ratio). Too little overlap -> 'inconclusive'.

    `events` (optional): this stock's own adjustments as [(ex_date, factor)]. They let the
    result say WHY it differs (_explain_level_changes) and catch events that predate the
    shared history - there the adjustment itself can't be tested, so a stock whose events
    are all like that is 'inconclusive' rather than a hollow 'match'.

    Also returns the dates inside the shared date range that only one side has
    (tvOnlyDates / oursOnlyDates), which the caller aggregates into calendar differences.
    """
    events = events or []
    empty = {'bars': 0, 'barsOff': 0, 'maxDevPct': None, 'worstDate': None, 'firstOff': None,
             'lastOff': None, 'tvOnlyDates': [], 'oursOnlyDates': [], 'causes': []}
    common = sorted(set(our_closes) & set(tv_closes))
    if len(common) < min_bars:
        return {**empty, 'status': 'inconclusive', 'bars': len(common),
                'note': f'Only {len(common)} matching bars - too few to compare'}

    ratios = [tv_closes[d] / our_closes[d] for d in common]
    devs = [(d, r - 1) for d, r in zip(common, ratios)]
    off = [(d, dev) for d, dev in devs if abs(dev) > tolerance + 0.01 / our_closes[d]]
    worst_date, worst = max(devs, key=lambda x: abs(x[1]))
    status = 'match'
    if off:
        status = 'major' if (abs(worst) >= 0.05 or len(off) >= 5) else 'minor'

    lo, hi = common[0], common[-1]
    untestable = [ex for ex, _ in events if ex <= lo]
    if events and len(untestable) == len(events) and status == 'match':
        status = 'inconclusive'

    tv_only = sorted(d for d in tv_closes if lo <= d <= hi and d not in our_closes)
    ours_only = sorted(d for d in our_closes if lo <= d <= hi and d not in tv_closes)
    causes = _explain_level_changes(common, ratios, our_closes, events, tolerance) if off else []

    if off:
        note = (f"{len(off)} of {len(common)} bars differ by more than {tolerance * 100:.0f}% "
                f"(worst {worst * 100:+.2f}% on {format_date(worst_date)})")
    elif status == 'inconclusive':
        note = (f'Adjustment predates the shared history ({format_date(lo)} onward) - '
                f'both sides are already on the post-event scale, so it cannot be tested')
    else:
        note = f'Matches on all {len(common)} bars (largest difference {abs(worst) * 100:.2f}%)'
        if untestable:
            note += f'; {len(untestable)} older event(s) predate the shared history'
    return {'status': status, 'bars': len(common), 'barsOff': len(off),
            'maxDevPct': round(worst * 100, 3), 'worstDate': format_date(worst_date),
            'firstOff': format_date(off[0][0]) if off else None,
            'lastOff': format_date(off[-1][0]) if off else None,
            'tvOnlyDates': [format_date(d) for d in tv_only],
            'oursOnlyDates': [format_date(d) for d in ours_only],
            'causes': causes, 'note': note}
