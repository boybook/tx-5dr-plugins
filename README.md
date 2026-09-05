# TX-5DR Plugins

Official external plugin repository for TX-5DR.

## Purpose

- Keep non-builtin plugins out of the main application repository
- Publish an official marketplace catalog from a single source of truth
- Distribute packaged plugin ZIP assets through OSS only

## Repository Layout

Each published plugin lives in a dedicated top-level directory:

```text
tx-5dr-plugins/
  plugin-a/
  plugin-b/
  .github/
```

Private shared source packages may live below `shared/` without a `tx5drPlugin`
metadata block; the root scripts ignore them. A plugin only needs to keep
its own source, metadata, build script, and packaging logic inside its folder.

## Plugin Contract

Each plugin directory is self-contained. CI scans top-level directories and
treats only directories containing a `tx5drPlugin` metadata block as published
plugins.

Each plugin must expose a uniform contract to CI:

- `scripts.build`: prepares all build outputs needed for release packaging
- `tx5drPlugin.pluginName`: runtime plugin directory name
- `tx5drPlugin.entry`: built entry module path used for validation
- `tx5drPlugin.include`: files or directories copied into the released ZIP
- `tx5drPlugin.minPluginApiVersion`: oldest bundled `@tx5dr/plugin-api` version
  that supports the plugin; it is unrelated to the TX-5DR nightly product version

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
    "minPluginApiVersion": "1.0.0",
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

Repository scaffold with migrated demo plugins and the external FT contest family:

- `heartbeat-demo`
- `iframe-panel-demo`
- `qso-session-inspector`
- 13 standard FT8/FT4 contest plugins
- `ww-digi`

Root tooling is just plain Node scripts under `scripts/`:

- `node scripts/validate-marketplace.mjs`
- `node scripts/build-plugins.mjs`
- `node scripts/package-market.mjs --channel nightly`

## Local Host Development

The contest packages are developed against the Host worktree without copying
their source into the Host repository. Set `TX5DR_HOST_ROOT` to the exact Host
worktree that is under test; the local build then links the public API and build
tools from that worktree and skips npm installation:

```bash
TX5DR_HOST_ROOT=/Users/fangyizhou/Documents/coding/tx-5dr-ft8-contest-family-plugins \
  node scripts/build-plugins.mjs
```

To make the Host discover those built artifacts, create ignored development
links in the Host worktree:

```bash
TX5DR_PLUGINS_ROOT=/Users/fangyizhou/Documents/coding/tx-5dr-plugins \
  node /Users/fangyizhou/Documents/coding/tx-5dr-ft8-contest-family-plugins/scripts/link-marketplace-plugins.mjs
```

Run the Host with `TX5DR_PLUGINS_DIR` pointing at
`<host-worktree>/.dev/plugins`, then rescan plugins. The links point to each
plugin's `dist` directory and are never included in Git or release artifacts.
