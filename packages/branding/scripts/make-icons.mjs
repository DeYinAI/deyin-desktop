// Generate the desktop app icons from the deyin mark SVG.
//
// Writes apps/desktop/build/{icon.png (Linux, 512px), icon.ico (Windows,
// multi-size), icon.icns (macOS)}. The build/ dir is gitignored, so CI runs
// this before packaging — keep it the single source of truth for both local
// and CI icon generation.
//
// Deps (root devDependencies): sharp, png-to-ico, png2icons.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const svgPath = join(here, "..", "assets", "logo-mark.svg");
const buildDir = join(here, "..", "..", "..", "apps", "desktop", "build");

// Windows .ico bundles these sizes; 512 is the primary app icon.
const ICO_SIZES = [16, 32, 64, 128, 256];
const PNG_SIZE = 512;
// macOS .icns needs a large square source; 1024 is the standard master size.
const ICNS_SIZE = 1024;

async function main() {
  let sharp;
  let pngToIco;
  let png2icons;
  try {
    ({ default: sharp } = await import("sharp"));
    ({ default: pngToIco } = await import("png-to-ico"));
    ({ default: png2icons } = await import("png2icons"));
  } catch {
    console.error("Missing deps. Run `pnpm add -D -w sharp png-to-ico png2icons`, then retry.");
    process.exit(1);
  }

  const { readFile } = await import("node:fs/promises");
  const svg = await readFile(svgPath);
  await mkdir(buildDir, { recursive: true });

  const render = (size) => sharp(svg, { density: 384 }).resize(size, size).png().toBuffer();

  // Primary icon (Linux + fallback source).
  await writeFile(join(buildDir, "icon.png"), await render(PNG_SIZE));

  // Windows multi-size .ico.
  const icoBuffers = await Promise.all(ICO_SIZES.map(render));
  await writeFile(join(buildDir, "icon.ico"), await pngToIco(icoBuffers));

  // macOS .icns from a 1024px master (BILINEAR resize inside png2icons).
  const master = await render(ICNS_SIZE);
  const icns = png2icons.createICNS(master, png2icons.BILINEAR, 0);
  if (!icns) throw new Error("Failed to generate icon.icns");
  await writeFile(join(buildDir, "icon.icns"), icns);

  console.log(`Wrote icon.png (${PNG_SIZE}px), icon.ico [${ICO_SIZES.join(", ")}], icon.icns (${ICNS_SIZE}px) to ${buildDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
