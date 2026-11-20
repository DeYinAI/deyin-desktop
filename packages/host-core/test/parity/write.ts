/** Regenerates the tables in `docs/PARITY-GROK-BOT.md`: `pnpm --filter @deyin/host-core exec tsx test/parity/write.ts`. */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderParityBlock, withBlock } from "./render.js";
import { REPO_ROOT } from "./recovered.js";

const file = join(REPO_ROOT, "docs/PARITY-GROK-BOT.md");
writeFileSync(file, withBlock(readFileSync(file, "utf8"), renderParityBlock()));
console.log(`wrote ${file}`);
