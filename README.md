# @martin/dsh-model-dial

Live dial for the local 27B, shown in the DSH web app's session header corner.

The llama-server (llama.cpp, TurboQuant build) streams no progress over HTTP,
but it tells the truth in two places this plugin reads:

- `GET http://127.0.0.1:8080/slots` — phase (idle / prefill / decode), task id,
  context size, prompt tokens processed, tokens decoded.
- the server's own log file (`llama-server-*.log`, UTF-16, under the
  TurboQuantLlamaCppSetup logs dir) — the `print_timing` lines carry the
  prefill **progress %**, prompt tokens/s, and the decode `tg_3s` rate that
  the DOS window shows.

Host half (`lib/index.js`, runs in the DSH host process): polls `/slots` every
750 ms and tails the newest log file, then publishes one Remote,
`modelDial.status()`, returning a small frozen status object. The dial is
decorative: a dead server just reports `phase: "down"`.

Client half (`lib/client.js`, browser): a 34 px ring in the session header
corner (same slot the voice toggles use).

  - prefill: amber ring filling to the server's own progress %, % in the
    middle, `tokens · tok/s` underneath
  - decode:  green ring, generated-token count in the middle, tok/s underneath
  - idle:    grey ring, dot
  - down:    red ring, `!`

Hover for the full line (task id, context size, ...).

## Build

```
pnpm install
pnpm bundle     # -> lib/index.js (host) + lib/client.js (browser)
```

## Install (this machine)

1. web profile package.json: link dependency + `dsh.profile.bundles` entry
2. junction `~/.dsh/profiles/web/node_modules/@martin/dsh-model-dial` -> this repo
3. restart the web host (the dial appears after a page refresh)

The package must keep its `dsh.bundle.patch` declaration (pointing at
`cordis.patch.yml`, which inserts the one host row) — without it the host
silently skips the whole bundle with "declares no dsh.bundle" and the dial
never appears. Changes to package.json or the patch need a web-host restart;
rebuilt `lib/` client bundles are picked up on a plain page refresh.

## Config (env overrides, read at host start)

- `DSH_DIAL_PORT` — llama-server port, default 8080
- `DSH_DIAL_LOG_DIR` — log dir, default the TurboQuantLlamaCppSetup logs dir
