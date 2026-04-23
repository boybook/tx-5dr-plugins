# TX-5DR Plugins

Official external plugin repository for TX-5DR.

## Purpose

- Keep non-builtin plugins out of the main application repository
- Publish an official marketplace catalog from a single source of truth
- Distribute packaged plugin ZIP assets through OSS only

## Repository Layout

Each plugin lives in a dedicated top-level directory:

```text
tx-5dr-plugins/
  plugin-a/
  plugin-b/
  .github/
```

There is no monorepo package nesting requirement. A plugin only needs to keep
its own source, metadata, build script, and packaging logic inside its folder.

## Plugin Contract

Each plugin directory is self-contained. CI scans every top-level directory and
treats any directory containing `package.json` as a plugin.

Each plugin must expose a uniform contract to CI:

- `scripts.build`: prepares all build outputs needed for release packaging
- `tx5drPlugin.pluginName`: runtime plugin directory name
- `tx5drPlugin.entry`: built entry module path used for validation
- `tx5drPlugin.include`: files or directories copied into the released ZIP

`package-lock.json` is optional. If present, CI uses `npm ci`; otherwise it
falls back to `npm install`.

Example:

```json
{
  "scripts": {
    "build": "tsc"
  },
  "tx5drPlugin": {
    "pluginName": "example-plugin",
    "title": "Example Plugin",
    "description": "Example description",
    "minHostVersion": "1.0.0",
    "entry": "dist/index.js",
    "include": [
      { "from": "dist/index.js", "to": "index.js" },
      { "from": "src/locales", "to": "locales" }
    ]
  }
}
```

This keeps plugin-specific build logic inside the plugin while letting CI use a
single packaging and publishing path. Adding a new plugin does not require
editing any root package manifest.

## Release Channels

- `nightly`: built automatically from `main`
- `stable`: promoted after review

## Distribution

- Marketplace catalog JSON and ZIP assets are uploaded to OSS
- Distribution base URL: `https://dl.tx5dr.com/plugins/market`
- GitHub Releases are not used for plugin distribution
- TX-5DR clients read the official marketplace catalog from a fixed URL

## Current Status

Initial repository scaffold with migrated demo plugins:

- `heartbeat-demo`
- `iframe-panel-demo`
- `qso-session-inspector`

Root tooling is just plain Node scripts under `scripts/`:

- `node scripts/validate-marketplace.mjs`
- `node scripts/build-plugins.mjs`
- `node scripts/package-market.mjs --channel nightly`
