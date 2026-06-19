# Loom Design System — Conventions

## Dark-mode first

All OKLCH color tokens are defined on `:root` and `[data-theme="dark"]` simultaneously, making dark mode the default. **Preview wrappers must supply an explicit dark background** (`oklch(0.145 0.008 286)`) — the preview renderer's HTML sets `body { background: #fff }`, which makes transparent/low-opacity surfaces invisible without this wrapper.

## Component imports

Components are exported from `loom` (the synthetic entry at repo root). Import pattern:

```tsx
import { Button, AsyncButton, OverlayShell } from "loom";
```

## Button

Four variants: `default` (secondary, subtle border), `primary` (violet/`--accent`), `ghost` (transparent), `destructive` (red). Three sizes: `sm`, `md` (default), `lg`.

Icon props: `iconLeft`, `iconRight` (Phosphor class name, e.g. `"ph-plus"`), or `iconOnly` for icon-only buttons. Loading state via `loading` prop (spinner replaces content). Disabled via `disabled` prop.

## AsyncButton

Class-based — apply `className="btn"` for secondary or `className="btn primary"` for violet primary. Accepts `icon` (Phosphor class name), `loadingLabel`, and an async `onClick` that returns a Promise. Spinner shows automatically during the pending state.

## Icons (Phosphor)

Icons use the Phosphor web font. Class pattern: `.ph .ph-icon-name` (e.g. `<i className="ph ph-plus" />`). Weight variants: `.ph` (regular), `.ph-bold`, `.ph-fill`. Full glyph list at [phosphoricons.com](https://phosphoricons.com).

## OverlayShell

Uses `Dialog.Portal` (Radix UI), which renders `position:fixed` content outside the normal DOM flow. **Preview stories cannot use the real component directly** — its Portal content falls outside the card bounds and renders blank. Instead, simulate the overlay visually using a bounded `position:relative` container with the same CSS classes (`.modal`, `.modal-head`, `.modal-body`, `.modal-foot`, `.modal-field`). The scrim is `rgba(0,0,0,0.45)` with `backdropFilter: blur(3px)`.

## Runtime CSS variables

`--mod`, `--swatch`, `--shadow-lg`, and `--r-base` are set at runtime by the app's theme engine — they are intentionally absent from the shipped stylesheet and can be ignored in preview contexts.
