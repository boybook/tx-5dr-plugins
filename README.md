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
- `tx5drPlugin.minPluginApiVersion`: bundled `@tx5dr/plugin-api` version the
  plugin requires, matched with `^` semantics; it is unrelated to the TX-5DR
  product version

`package-lock.json` is optional. If present, CI uses `npm ci`; otherwise it
falls back to `npm install`.

Example:

```json
{
  "version": "1.0.0",
  "scripts": {
    "build": "tsc"
  },
  "devDependencies": {
    "@tx5dr/plugin-api": "^2.6.0"
  },
  "tx5drPlugin": {
    "pluginName": "example-plugin",
    "title": "Example Plugin",
    "description": "Example description",
    "minPluginApiVersion": "2.6.0",
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

## Versioning and Distribution

There are no release channels. Every plugin version is published once and kept:

- A push to `main` publishes each plugin whose `package.json` version is not in
  `registry/<plugin>.json` yet. The archive is uploaded once to
  `https://dl.tx5dr.com/plugins/market/artifacts/<plugin>/<version>.zip` and
  never overwritten; CI then commits the new registry entry.
- `https://dl.tx5dr.com/plugins/market/index.json` (schema v3) lists every
  version. A Host installs the newest non-yanked version whose
  `minPluginApiVersion` its bundled Plugin API satisfies with `^` semantics
  (`>=` the declared version, same major). If none exists, the Host explains
  whether TX-5DR must be updated or the plugin has not been updated yet.
- `nightly/index.json` and `stable/index.json` (schema v2, identical content)
  are generated only for already released Hosts that still read channels. They
  offer each plugin's newest version those Hosts can run. Do not delete
  `nightly/artifacts/`: earlier releases and registry entries reference it.
- GitHub Releases are not used for plugin distribution.
- Deployment runs only from `main`, in two jobs: plugins are built without
  write credentials, then a separate job uploads archives and commits the
  registry. Do not roll back by reverting the deploy workflow; the old channel
  workflow overwrote `nightly/artifacts/*.zip`, which registry entries pin by
  hash. Fix forward with a new plugin version or a yanked entry instead.
- Commit each plugin's `package-lock.json` (including `shared/`). Contest
  plugins bundle `@tx5dr/plugin-api`, so an unlocked install could ship code
  newer than the declared `minPluginApiVersion`.

Rules enforced by `scripts/validate-marketplace.mjs`:

- `minPluginApiVersion` (package metadata and runtime definition) must not be
  lower than the `@tx5dr/plugin-api` range the plugin or any bundled `shared/`
  package builds against, and must stay in the same major. Plugin authors can
  run the same declaration check locally with
  `npm exec --package=@tx5dr/plugin-api@^2.7.0 -- tx5dr-plugin check`
  (not `npx tx5dr-plugin`: no npm package has that name). Every plugin must
  depend on `@tx5dr/plugin-api` so this can be checked.
- Changing a published plugin's packaged sources requires a new `version`.
  README and test changes do not.

To withdraw a broken version, set `"yanked": true` and a `"yankedReason"` on its
entry in `registry/<plugin>.json` through a pull request. Hosts stop offering it;
the archive stays available for audit. Publish a fixed higher version instead of
replacing bytes.

Publication tooling:

```bash
node scripts/validate-marketplace.mjs
node scripts/build-plugins.mjs
node scripts/package-market.mjs                 # deterministic archives + candidates
node scripts/publish-market.mjs --dry-run       # index files in .artifacts/market/site
node scripts/check-catalog-compat.mjs           # parse them with released Host schemas
node --test scripts/tests/*.test.mjs
```

## Current Status

Repository scaffold with migrated demo plugins and the external FT contest family:

- `heartbeat-demo`
- `iframe-panel-demo`
- `qso-session-inspector`
- 13 standard FT8/FT4 contest plugins
- `ww-digi`

Root tooling is plain Node scripts under `scripts/`; see Versioning and
Distribution above.

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
