# Frame History Viewer

Browse historical FT8/FT4 decode frames stored in JSONL log files.

## Features

- **Date browser**: pick a date to view its recorded slots
- **Band filter**: filter slots by amateur band (dynamically populated from the loaded data)
- **Band & frequency**: each slot shows the band (e.g. `20m`) and dial frequency
- **Expandable slots**: click a slot to reveal its decoded frames in a sortable table
- **Live search**: filter frames by message text with highlighted matches and 200ms debounce
- **SNR color coding**: color-coded SNR values (green ≥ −5, yellow ≥ −15, red < −15, TX marker)
- **Responsive layout**: adapts to narrow screens (e.g. mobile devices)
- **Internationalization**: English and Chinese (简体中文) with dynamic locale switching
- **Toolbar entry**: opens as a popover from the RadioControl toolbar
- **Dark/light theme**: matches the TX-5DR host theme via CSS Design Tokens

## Installation

1. Download the plugin ZIP from [marketplace](https://tx5dr.com/plugins/frame-history-viewer) or build from source.
2. Extract into your TX-5DR plugins directory:

   ```
   {dataDir}/plugins/frame-history-viewer/
   ├── index.js
   ├── locales/
   └── ui/
   ```

3. Reload plugins in **Settings → Plugins**, or restart TX-5DR.

## Usage

After installation, a clock icon button appears in the RadioControl toolbar (to the right of the antenna tuner button). Click it to open the viewer popover.

1. **Select a date** from the dropdown at the top.
2. Browse the list of slots — each shows time range, band/frequency, frame count, and mode.
3. **Click a slot** to expand and see its individual frames in a table.
4. **Search** by typing in the search box — matching frames are filtered in real time with highlights.

## Internationalization

The plugin supports English and Chinese (简体中文). The locale is determined automatically from the TX-5DR host locale and can switch dynamically at runtime via `window.tx5dr.onLocaleChange`. UI strings are bound to HTML elements through `data-i18n`, `data-i18n-placeholder`, and `data-i18n-title` attributes.

Translation files are located at `src/locales/en.json` and `src/locales/zh.json`.

## Data source

The plugin reads JSONL files directly from:

```
{dataDir}/frames-logs/frames-{YYYY-MM-DD}.jsonl
```

Each line is a JSON object (`SlotPackStorageRecord`) containing a `slotPack` with decoded frames, `storedAt` timestamp, `operation` type (`created`/`updated`), and optional `mode` string.

These files are written by TX-5DR's `SlotPackPersistence` subsystem. No network requests or admin API permissions are needed.

### Data directory resolution

The `dataDir` is resolved at runtime in the following order, mirroring the host's `tx5drPaths.getDataDir()`:

1. `TX5DR_DATA_DIR` environment variable (injected by Docker, the Linux server package, and the Electron desktop app)
2. `%LOCALAPPDATA%\TX-5DR` (Windows)
3. `~/Library/Application Support/TX-5DR` (macOS)
4. `$XDG_DATA_HOME/TX-5DR` or `~/.local/share/TX-5DR` (standard Linux user installation)

## Build from source

```bash
npm install
npm run build
```

Output: `dist/index.js`. UI files are static and live in `ui/`.

## Structure

```
frame-history-viewer/
├── src/
│   ├── index.ts          # Plugin definition & server-side file reader
│   └── locales/
│       ├── en.json       # English translations
│       └── zh.json       # Chinese (简体中文) translations
├── ui/
│   ├── viewer.html       # Iframe page entry
│   ├── viewer.css        # Theme-aware styles
│   └── viewer.js         # Client-side rendering & search
├── package.json          # npm metadata & plugin manifest
├── package-lock.json     # Locked dependency tree
└── tsconfig.json         # TypeScript compiler configuration
```
