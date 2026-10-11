# @martin/dsh-model-dial

A small live progress dial in the DSH web app's session header, beside the existing actions. It reads a local llama.cpp server's status and diagnostic log without controlling the model.

- Fresh prompt-processing progress: amber ring, percentage and a small “prompt processing” label.
- Generation: grey dot with a “generating” label.
- Idle, unavailable or stale progress: grey dot; hover for status.

The current UI deliberately leaves speeds and token totals to the app's existing status bar. The host snapshot also includes task ID, token counts and throughput when those values are available.

## How it works

The host polls `http://127.0.0.1:8080/slots` every 750 ms and reads newly appended bytes from the newest `llama-server-*.log`. It publishes a `modelDial.status` Remote. The browser polls this snapshot every second and registers a 34 px gauge in `conversation.session.header.actions`, leaving the app's corner controls alone.

Log parsing expects the UTF-16LE files and task progress/timing format used by the tested Windows TurboQuant llama.cpp installation. Other builds may expose different slot fields or log formats. Without matching fresh log progress, the gauge stays grey. An unavailable server reports `down`; polling errors are contained.

This plugin does not start, stop or resize a model, send inference requests, change CUDA graphs or select a voice device. It can be used alongside [@martin/dsh-local-model-manager](https://github.com/martindye/dsh-local-model-manager).

## Install

The repository includes built `lib/` files, sources and the host bundle patch. From a DSH checkout:

```text
pnpm dsh plugin --profile web add <path-to-dsh-model-dial-directory-or-tgz>
```

Restart the web host after active work finishes, then refresh the browser. The package name is `@martin/dsh-model-dial`; the bundle row ID is `model-dial`. Keep the `dsh.bundle.patch` declaration and `cordis.patch.yml` in the package: they register the host service the browser needs.

## Configuration

Environment overrides are read when the host loads the plugin:

| Variable | Default |
| --- | --- |
| `DSH_DIAL_PORT` | `8080`, on `127.0.0.1`. |
| `DSH_DIAL_LOG_DIR` | `OneDrive/Projects/TurboQuantLlamaCppSetup/logs` beneath the current user's home directory. |

The default log directory matches the existing Windows installation without embedding a particular user's name. For another installation, set an absolute log directory and use a server with the expected slot and log formats. This release has not established a platform or backend compatibility matrix.

## Build and package

Use Node.js 22.12 or newer with pnpm:

```text
pnpm install --frozen-lockfile
pnpm bundle
npm pack
```

The build produces the host ESM module and a browser factory registered with DSH's module loader. React and Cordis runtime modules are supplied by DSH. `npm pack` includes the compiled modules, source, README, license and bundle patch; dependency folders and local logs are excluded.

Publication checks validate the isolated build, JavaScript syntax and archive contents. They do not reload the installed plugin or perform inference on the active model.

## License

MIT, copyright 2026 Martin Dye.
