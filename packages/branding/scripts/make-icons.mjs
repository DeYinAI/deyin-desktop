// Generate the desktop app icons from the deyin mark SVG.
//
// Writes apps/desktop/build/icon.png (512px, used for Linux + as the macOS
// source electron-builder converts to .icns) and icon.ico (multi-size, Windows).
// The build/ dir is gitignored, so CI runs this before packaging — keep it the
// single source of truth for both local and CI icon generation.
//
// Deps (root devDependencies): sharp, png-to-ico.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const svgPath = join(here, "..", "assets", "logo-mark.svg");
const buildDir = join(here, "..", "..", "..", "apps", "desktop", "build");

// Windows .ico bundles these sizes; 512 is the primary app icon.
const ICO_SIZES = [16, 32, 64, 128, 256];
const PNG_SIZE = 512;

async function main() {
  let sharp;
  let pngToIco;
  try {
    ({ default: sharp } = await import("sharp"));
    ({ default: pngToIco } = await import("png-to-ico"));
  } catch {
    console.error("Missing deps. Run `pnpm add -D -w sharp png-to-ico`, then retry.");
    process.exit(1);
  }

  const { readFile } = await import("node:fs/promises");
  const svg = await readFile(svgPath);
  await mkdir(buildDir, { recursive: true });

  const render = (size) => sharp(svg, { density: 384 }).resize(size, size).png().toBuffer();

  // Primary icon (Linux + macOS source).
  await writeFile(join(buildDir, "icon.png"), await render(PNG_SIZE));

  // Windows multi-size .ico.
  const icoBuffers = await Promise.all(ICO_SIZES.map(render));
  await writeFile(join(buildDir, "icon.ico"), await pngToIco(icoBuffers));

  console.log(`Wrote icon.png (${PNG_SIZE}px) and icon.ico [${ICO_SIZES.join(", ")}] to ${buildDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
