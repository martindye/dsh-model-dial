# @martindye/dsh-model-dial

A live dial for the local llama.cpp model, shown in the DSH web app's
session header: a 34 px ring that shows what the model is doing right now.

llama-server (llama.cpp) streams no progress over HTTP, but it tells the
truth in two places this plugin reads:

- `GET http://127.0.0.1:8080/slots` — phase (idle / prefill / decode), the
  task id, prompt and generated token counts, the request's own params.
- the server's own log file (`llama-server-*.log`, UTF-16) — the
  `print_timing` lines carry the prompt-processing **progress %** and the
  decode rate.

On top of that, the host half tails the DSH session log
(`session.v4.jsonl.zstd`) for the `compaction/start` … `compaction/end`
pair, so the minutes the model spends summarising the old context (prompt
compaction) are surfaced too — with the summary's live percentage.

## What the dial shows

- **prompt processing** — an amber ring filling to the server's own
  progress %, the % in the middle.
- **generating** — a small "generating" label while tokens decode.
- **compacting** — the harness summarising old context: an amber ring at
  the summary's live progress (tokens generated over the summarisation
  budget the request was given), % in the middle; a blind slow spin while
  no progress is known yet (the first seconds).
- **idle / down** — a grey ring with a dot; hover for the detail (no
  active processing, or the server unreachable at 127.0.0.1:8080).

The dial is decorative: nothing it does may ever take the host down, and a
dead server simply reads "down".

## Layout

- `src/index.ts` — the host half (runs in the DSH host process): polls
  `/slots` every 750 ms, tails the newest llama-server log and the DSH
  session log, and publishes the `modelDial.status` Remote.
- `src/sessionlog.ts` — the zstd-frame walker and the compaction-event
  parser for the session log.
- `src/client/Dial.tsx` — the 34 px ring in the session header.
- `lib/` — build output (`lib/index.js` node half, `lib/client.js` browser
  bundle). Rebuild with `pnpm bundle`.

## Installing

From npm (the published package ships prebuilt `lib/` — no build step):

```sh
dsh plugin --profile <profile> add @martindye/dsh-model-dial
```

for example `dsh plugin --profile web add @martindye/dsh-model-dial` for
the web app. Then restart the web host and open the app: the ring appears
in the header of an open session (it is a per-session control, so the
landing view has no dial).

Requirements: DSH 0.1.7+ (web app), Node 22+ on the host, and a local
llama.cpp server on 127.0.0.1:8080 — the dial is a viewer, it drives
nothing.

## Configuration (env overrides, read at host start)

- `DSH_DIAL_PORT` — the llama-server port, default 8080.
- `DSH_DIAL_LOG_DIR` — the llama-server logs directory (the dial needs the
  `llama-server-*.log` files for the prefill %).
- `DSH_DIAL_SESSIONS_DIR` — the DSH sessions directory, default
  `~/.dsh/sessions` (needed for the compaction indicator).

## Changelog (the latest updates)

- 24/10 — The compaction ring shows a live percentage: summary tokens
  generated over the summarisation budget, read straight off the model
  slot; the blind spin now only covers the first seconds.
- 22/10 — Compaction indicator: an amber "compacting" ring while the
  harness summarises the context (the session log's `compaction/start` …
  `compaction/end` pair), and an attach-race fix so a session switch or a
  host restart mid-compaction still lights it.
- 11/10 — Gauge-only face: a 0–1 progress ring from the server's own
  `progress = P` lines (live while a line is younger than 3 s); the
  speeds and totals live in the app bar, not the dial.
- 10/10 — First version: the 34 px ring in the session header, reading
  `/slots` plus a tail of the llama-server log.
