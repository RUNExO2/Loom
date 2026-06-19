# Loom Design System — Sync Notes

## Synced components
Button, AsyncButton, OverlayShell (scoped UI layer only — feature components excluded because they depend on Tauri IPC APIs and Zustand stores that can't run in a browser).

## Repo quirks

### Synth-entry mode (required)
This is a Tauri app repo, not a component library — no `dist/` entry, no self-installed `node_modules/loom`. Always pass `--entry ./loom-entry.tsx` to `package-build.mjs`:

```sh
node .ds-sync/package-build.mjs --config .design-sync/config.json \
  --node-modules ./node_modules --entry ./loom-entry.tsx --out ./ds-bundle
```

Without `--entry`, the build fails with `ENOENT: node_modules/loom/package.json`.

### Flat combined CSS entry (`loom-design-entry.css`)
The converter doesn't resolve `@import` chains. `loom-design-entry.css` is a pre-flattened 347 KB file containing:
- `src/styles/index.css` (full OKLCH token system + component CSS)
- `dist/phosphor/regular/style.css` (Phosphor glyph selectors + @font-face)
- `dist/phosphor/bold/style.css`
- `dist/phosphor/fill/style.css`

Font URLs are rewritten to `./fonts/` relative paths. If `src/styles/index.css` or Phosphor updates, **regenerate this file** using the Node.js script that built it originally (see comments in the file header). `extraFonts` in config copies the woff2 binaries.

### Preview dark background wrappers (required)
`src/styles/index.css` defines all color tokens on `:root, [data-theme="dark"]` (dark-mode first). The preview HTML renderer sets `body { background: #fff }` — all transparent/low-opacity surfaces become invisible on white. Every preview story wraps its content in an explicit dark background: `oklch(0.145 0.008 286)`.

### OverlayShell preview uses bounded container (not the real component)
`OverlayShell` uses `Dialog.Portal` (Radix UI) which renders `position:fixed` content outside the story element DOM bounds — per-story screenshot capture is blank. The preview (`.design-sync/previews/OverlayShell.tsx`) simulates the overlay visually using a bounded `position:relative` container with the same CSS classes. This is intentional; do not replace with the real component.

### Runtime CSS variables (non-blocking warnings)
`--mod`, `--swatch`, `--shadow-lg`, `--r-base` are set at runtime by the app's theme engine. `[TOKENS_MISSING]` warnings for these are expected and non-blocking on every sync.

### Google Fonts / Cascadia Code
`src/styles/index.css` has a remote `@import` for Google Fonts (Cascadia Code). `[FONT_REMOTE]` warning is expected and non-blocking.

## Re-sync risks
- If `src/styles/index.css` changes (new tokens, new component classes), **regenerate `loom-design-entry.css`**.
- If Phosphor icon package updates (new icon set, woff2 changes), **regenerate `loom-design-entry.css`** and rebuild.
- If new UI components are added to `src/components/ui/`, add them to `componentSrcMap` in config AND to `loom-entry.tsx`.
- If Tauri-dependent components are accidentally added to `componentSrcMap`, the build will fail at bundle time (Tauri IPC not available in browser sandbox).
