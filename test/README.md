# spice-html5 test harness

A fake SPICE server written for Bun plus Playwright and `bun:test` suites that
drive the client in `../src` exactly as a browser would. The client stays
plain JavaScript so its patches remain upstreamable; everything in here is
TypeScript.

```
test/
  server/      fake SPICE server (Bun): wire structs, message builders, control API, recorder
  unit/        bun:test — builders checked against the client's own parsers, OAEP tickets, frames
  e2e/         Playwright specs (Chromium + Firefox) and perf/ (Chromium, CDP metrics)
  fixtures/    recordings from real boxes (see Recording)
```

## Running

```bash
cd test
bun install
bun run unit                 # ~150 ms, no browser
bun run e2e                  # Chromium + Firefox
bun run e2e:chromium
bun run perf                 # Chromium only; compares against e2e/perf/baselines.json
bun run serve                # fake server on :5959 with the "desktop" scenario, open http://127.0.0.1:5959/
```

Playwright browsers are the ones cached for `@playwright/test` at the pinned
version; run `npx playwright install chromium firefox` after bumping it.

Open the served page by IP, not as `localhost`. Firefox with a proxying
VPN extension stalled `ws://localhost` for the client's full 30 s connect
timeout while `ws://127.0.0.1` opened in 5 ms against the same server.
The page logs `ws open/error/close` with timings to the console;
`?ws=ws://host:port/spice` points it at another server.

## How it fits together

`server/server.ts` speaks the real link handshake (RSA-1024 SPKI in the link
reply, OAEP/SHA-1 ticket decrypt, real password check), mini-header framing,
and enough of main/display/inputs/cursor/playback to exercise every handler
the client has. It is scripted over HTTP (`/__control/*`) because Playwright
runs on Node while the server runs on Bun, so `e2e/fixtures.ts` spawns
`server/cli.ts` per worker and talks to it:

- `spice.reset({...})` — password, channel list, fragmentation mode (whole /
  fixed chunk / seeded random / coalesce), link error, bad magic, delayed or
  dropped handshake, mouse modes, agent presence, ack window, scenario, replay.
- `spice.send(channel, builder, args)` — any builder in `server/messages.ts`.
  `image: { kind: "quadrants" | "solid", width, height, frame?, flip? }`
  is rendered server-side (raw BGRx for bitmaps, jpeg-js for JPEG and MJPEG).
- `spice.run({ cmd: "stream", args })` — paced MJPEG stream with synthetic
  or recorded frames; `drawBurst` for draw-heavy loads; `close` to drop a
  channel; `raw` for arbitrary bytes.
- `spice.inbound(channel, name, since)` / `spice.waitFor(...)` — every
  client-to-server message, decoded (scancodes, mouse events, acks, pongs,
  stream reports, agent messages).

`e2e/page.html` is the page under test. It imports `/src/main.js` straight
from the repo and exposes `window.harness` (connect / disconnect / pixel
probes / typeText / sendCtrlAltDel). `fixtures.ts` also injects counters for
object URLs, canvases, images, sockets and long tasks before any page script
runs, so teardown and perf assertions need no hooks in the client.

Pixel assertions read the surface canvas directly. Quadrant images carry a
per-frame colour top-left and fixed colours elsewhere, which is enough to
tell which frame landed and which way up.

## Expected failures

Tests for behaviour the client does not have yet are marked
`test.fail(true, reason)`. They run, they fail today, and once the fix lands
Playwright reports them as unexpectedly passing, which is the cue to drop the
marker. Pinned today:

- `protocol.spec.ts` "DISCONNECTING from the server closes without an
  error": the client has no `SPICE_MSG_DISCONNECTING` handler, so the close
  that follows is reported through `onerror` as unexpected.

## Performance

`e2e/perf/perf.spec.ts` replays fixed workloads (MJPEG at two sizes, bitmap
and JPEG draw bursts, connect/disconnect cycles) and reads Chromium's
`Performance.getMetrics` over CDP before and after, plus the injected
counters. Every run writes `e2e/perf/results/<name>.json`. With an entry in
`e2e/perf/baselines.json` the gated metrics (`taskMs`, `scriptMs`,
`heapDeltaMB`, `longTaskMs`) must stay within 25 % of it plus a noise floor
(50 ms for the time metrics, 2 MB for heap) that stops sub-100 ms baselines
failing on scheduler jitter; for the current baselines that floor is the
larger part of the allowance, so treat the gate as catching 2x regressions,
not 30 % ones. Leaks (`urlsLeaked`) are always asserted to be zero.

```bash
PERF_UPDATE_BASELINES=1 bun run perf   # rewrite baselines from this machine
```

Numbers are only comparable on the same machine and browser build. Keep the
laptop plugged in and quiet; run twice and trust the second.

## Recording real boxes

```bash
bun server/record.ts --listen 5959 --upstream ws://<box>:<port> --out fixtures/<name>.rec.json
```

Point the client (or `page.html`) at `ws://localhost:5959`, do what you want
captured, Ctrl-C. The recorder relays bytes both ways and stores the server
side of each channel after authentication, with timestamps. Replay with
`spice.reset({ replay: "fixtures/<name>.rec.json" })` (relative paths
resolve against `test/`, whatever the runner's cwd) or
`bun server/cli.ts --replay fixtures/<name>.rec.json`: the handshake is
regenerated with a fresh key, everything after it is the recorded bytes on
the recorded schedule (`replaySpeed` scales it). This is how real QUIC, LZ,
VP8 and Windows cursor payloads get into the suite without hand-encoding them.

`fixtures/goldeye-win11-idle.rec.json` is one such capture (a TrueNAS 25.10
Windows 11 VM at idle, six channels, ~0.9 MB) and `e2e/replay.spec.ts`
replays it: the whole 1400x712 desktop must paint and the Windows cursor
must apply. Each new main-channel connection restarts the replay from the
top, so one server serves any number of sessions.

## Playing a fixture into another client

The fake server speaks SPICE over WebSocket only. A native client such as
`spicy` (Homebrew `spice-gtk`) needs a TCP bridge in front of it:

The server also listens for plain SPICE over TCP with `--tcp <port>`, so a native
client such as `spicy` (Homebrew `spice-gtk`) connects directly:

```bash
bun server/cli.ts --replay fixtures/goldeye-win7-xpdm.rec.json --port 5959 --tcp 5900 --loop
spicy --uri=spice://127.0.0.1:5900 -w ''
```

spicy takes ~15 s to appear on macOS (GStreamer plugin scan). `--loop` starts
the display, cursor and inputs streams over when the recording ends, after
destroying the surfaces it created, so any client sees a clean second pass;
the main channel keeps its session. A new main-channel connection always
restarts the replay from the top. The same replay through spice-html5 is
`http://127.0.0.1:5959/` in a browser (the page at `/` auto-connects).
`--speed 0.5` slows the replay, `--speed 4` hurries it.
