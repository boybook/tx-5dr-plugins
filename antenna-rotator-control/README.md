# Antenna Rotator Control

Global TX-5DR utility plugin for Hamlib-compatible azimuth antenna rotators.

## Features

- Adds a `radio-control-toolbar` iframe button to RadioControl.
- Uses FontAwesome `arrows-rotate` and a large popover UI.
- Talks to `hamlib@0.7.1` through a runtime `import('hamlib')`, expecting the host TX-5DR server to provide the dependency.
- Supports serial/USB and network `rotctld` style endpoints.
- Provides setup, connection testing, real position polling, manual target input, presets, STOP, park fallback, and diagnostics.

## Safety Defaults

- Azimuth-only v1; elevation is not controlled.
- First movement in a browser session requires confirmation.
- Large jumps, stale feedback, park, and reset require explicit confirmation.
- Commands are serialized, soft limits are enforced server-side, and movement timeout triggers a stop attempt.

## Build

```bash
npm install
npm run build
npm test
```

The plugin declares `hamlib@0.7.1` as an optional peer dependency and ships a local type shim for that API surface. Runtime still uses the host-provided Hamlib capability; the marketplace artifact must include `dist/index.js`, `dist/rotator-utils.js`, `src/locales`, and `dist/ui`, but never `node_modules/hamlib`.
