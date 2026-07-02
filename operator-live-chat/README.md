# operator-live-chat

`operator-live-chat` adds a shared real-time chat room to the TX-5DR
RadioControl toolbar for operator and admin accounts.

## Features

- Single shared room for all logged-in operator and admin accounts
- Real-time message fanout to every open chat popover
- Toolbar activity hint that switches icon/title when new messages arrive
- Token-label based sender names via `/api/auth/me`
- Local development flow with symlink + `.hotreload`

## Build

```bash
npm install
npm run build
```

## Local development

```bash
npm install
npm run build
npm run link
```

Watch mode:

```bash
npm run dev:server
npm run dev:ui
```

If the TX-5DR host does not pick up the plugin automatically, open
`Settings -> Plugins` and run `Reload` or `Rescan`.

### Link target resolution

`npm run link` resolves the host plugin directory in this order:

1. `TX5DR_PLUGINS_DIR`
2. `TX5DR_DATA_DIR/plugins`
3. Linux default: `~/.local/share/TX-5DR/plugins`

You can remove the symlink with:

```bash
npm run link -- --unlink
```

The script also creates `dist/.hotreload` so the TX-5DR development runtime can
reload the plugin after rebuilt files change.

## Packaging

This plugin follows the external marketplace packaging contract via the
`tx5drPlugin` field in `package.json`.
