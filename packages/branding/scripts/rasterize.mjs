// Rasterize the SVG mark into the PNG/ICO sizes electron-builder needs.
// Uses `sharp` if available. Install once with: pnpm add -D sharp -w
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const assets = join(here, "..", "assets");
const outDir = join(assets, "generated");

const SIZES = [16, 32, 64, 128, 256, 512, 1024];

async function main() {
  let sharp;
  try {
    ({ default: sharp } = await import("sharp"));
  } catch {
    console.error(
      "sharp is not installed. Run `pnpm add -D sharp -w`, then `pnpm --filter @deyin/branding rasterize`.",
    );
    process.exit(1);
  }

  await mkdir(outDir, { recursive: true });
  const svg = await readFile(join(assets, "logo-mark.svg"));

  for (const size of SIZES) {
    const png = await sharp(svg, { density: 384 }).resize(size, size).png().toBuffer();
    await writeFile(join(outDir, `icon-${size}.png`), png);
  }
  // Primary app icon.
  const icon512 = await sharp(svg, { density: 384 }).resize(512, 512).png().toBuffer();
  await writeFile(join(outDir, "icon.png"), icon512);

  console.log(`Wrote ${SIZES.length + 1} PNGs to ${outDir}`);
  console.log("For Windows .ico / macOS .icns, feed these PNGs to electron-icon-builder or png2icons.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
