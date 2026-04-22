# TX-5DR Plugins

Official external plugin repository for TX-5DR.

## Purpose

- Keep non-builtin plugins out of the main application repository
- Publish an official marketplace catalog from a single source of truth
- Distribute packaged plugin ZIP assets through OSS/CDN only

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

## Release Channels

- `nightly`: built automatically from `main`
- `stable`: promoted after review

## Distribution

- Marketplace catalog JSON and ZIP assets are uploaded to OSS
- GitHub Releases are not used for plugin distribution
- TX-5DR clients read the official marketplace catalog from a fixed URL

## Current Status

Initial repository scaffold. CI and packaging scripts will be added next.
