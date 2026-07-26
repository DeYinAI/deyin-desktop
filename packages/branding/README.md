# @deyin/branding

Deyin brand assets and design tokens. All original artwork.

- `assets/logo-mark.svg` — the icon-only mark (soundwave / echo motif; "deyin" = sound).
- `assets/logo-wordmark.svg` — mark + wordmark.
- `src/tokens.ts` — colors, radii, spacing, typography, and a `cssVariables()` helper.

## Usage

```ts
import { colors, cssVariables, assetPath } from "@deyin/branding";

document.head.insertAdjacentHTML("beforeend", `<style>${cssVariables()}</style>`);
```

## Generating raster icons

```bash
pnpm add -D sharp -w
pnpm --filter @deyin/branding rasterize   # -> assets/generated/icon-*.png
```

Feed the generated PNGs to `png2icons` (or `electron-icon-builder`) to produce the
`.ico` (Windows) and `.icns` (macOS) files electron-builder references.
