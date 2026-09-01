const fs = require("fs");
const s = fs.readFileSync("packages/ui/client/src/styles.css", "utf8");
const defs = [...s.matchAll(/--radius[a-z-]*\s*:/g)].map((m) => m[0]);
const uses = [...s.matchAll(/var\(--radius[a-z-]*\)/g)].map((m) => m[0]);
const uniq = (a) => [...new Set(a)].sort();
console.log("DEFS:", JSON.stringify(uniq(defs)));
console.log("USES:", JSON.stringify(uniq(uses)));
const head = fs.execSync ? null : null;
