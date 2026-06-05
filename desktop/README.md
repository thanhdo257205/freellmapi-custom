# FreeLLMAPI Desktop

Lean Electron menu-bar app for [freellmapi](https://github.com/tashfeenahmed/freellmapi):
runs the whole router locally on `127.0.0.1:31415`, with a dark-glass tray
popover (live 24h request chart, quick stats, copy URL/key) and the full
dashboard in a native-feeling window.

## Layout requirement

This repo builds against a **sibling checkout** of the main repo:

```
…/experiments/
  freeapi/            # the freellmapi repo (server + client sources)
  freeapi-desktop/    # this repo
```

A different location can be set with `FREEAPI_REPO=/path/to/freeapi` (dev
runtime); the esbuild import paths in `src/server-host.ts` and the
`extraResources` entry in `electron-builder.yml` assume the sibling layout.

The sibling checkout must include the embedder hooks (`CLIENT_DIST` /
`FREEAPI_ENV_PATH` env overrides in the server, desktop-mode navbar in the
client) and a built `client/dist`:

```bash
cd ../freeapi
npm install
npm run build -w client
```

## Develop

```bash
npm install
npm run rebuild:native   # better-sqlite3 against Electron's ABI (dev loop only)
npm run dev              # bundle + launch
```

UI iteration helpers (dev only): `FREEAPI_SHOT=1 npx electron .` captures the
popover + dashboard to /tmp and quits; `FREEAPI_SHOT=hold` pins the popover
open for real-screen captures.

## Package

```bash
npm run dist             # electron-builder → dist-electron/FreeLLMAPI-…-arm64.dmg
```

## Notes

- DB + config live in `~/Library/Application Support/FreeLLMAPI/`.
- The server binds loopback only; default port 31415, scan-up on conflict,
  resolved port persisted.
- Do not run plain `npm rebuild` here — it rebuilds better-sqlite3 for the
  system Node ABI and breaks the Electron dev loop (`npm run rebuild:native`
  fixes it). Packaging rebuilds natives itself.
