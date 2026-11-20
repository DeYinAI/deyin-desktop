#!/usr/bin/env node
/**
 * Re-derive the Grok Bot wire contract from an extracted app.asar.
 *
 *   node recover-contract.mjs <extracted-asar-dir> <out-dir>
 *
 * Reads only `dist/electron-main/proto.cjs` and `dist/electron-main/main-app.cjs`
 * as inert text (nothing is executed) and writes:
 *   proto-services.json          service -> methods [{ key, name, input, output, kind }]
 *   proto-shapes.json            message name -> "field no name type|..." descriptor
 *   proto-enums.json             enum name -> ["0=UNSPECIFIED", ...]
 *   connector-readonly-tools.json connector -> read-only tool names
 *   avatar-palette.json          avatar shapes, default-shape pool, colors, expression states
 *   grokbot-methods.txt          sorted GrokBotService method names
 *
 * The output is interface metadata (names, numbers, enum values), the same
 * facts a client has to know to talk to the service. It is the spec Deyin Bot
 * is built against; no Grok Bot code or UI copy is carried over.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [asarDir, outDir] = process.argv.slice(2);
if (!asarDir || !outDir) {
  console.error("usage: recover-contract.mjs <extracted-asar-dir> <out-dir>");
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });

const proto = readFileSync(join(asarDir, "dist/electron-main/proto.cjs"), "utf8");
const mainApp = readFileSync(join(asarDir, "dist/electron-main/main-app.cjs"), "utf8");
const write = (name, value) =>
  writeFileSync(join(outDir, name), typeof value === "string" ? value : JSON.stringify(value, null, 2));

// 1. Services and their methods.
const services = {};
for (const m of proto.matchAll(/var\s+([A-Za-z0-9_$]+)=\{typeName:"(aiserver\.v1\.[A-Za-z]+)",methods:\{([\s\S]*?)\}\}/g)) {
  const [, , typeName, body] = m;
  services[typeName] = [
    ...body.matchAll(
      /([A-Za-z0-9_]+):\{name:"([A-Za-z0-9]+)",I:([A-Za-z0-9_$]+),O:([A-Za-z0-9_$]+),kind:([A-Za-z0-9_.$]+)\}/g,
    ),
  ].map((x) => ({ key: x[1], name: x[2], input: x[3], output: x[4], kind: x[5] }));
}
write("proto-services.json", services);

// 2. Message shapes: `static $(){return["Name|1 field 9|2 other 8|..."...]}`.
const shapes = {};
for (const m of proto.matchAll(/\$\{?\(\)\{return\["([A-Za-z0-9_]+)\|([^"]*)"[^\]]*\]\}/g)) shapes[m[1]] = m[2];
for (const m of proto.matchAll(/\$\(\)\{return\["([A-Za-z0-9_]+)\|([^"]*)"/g)) shapes[m[1]] = m[2];
write("proto-shapes.json", shapes);

// 3. Enums: `fn(s,d,"Name",[[0,"UNSPECIFIED"],[1,"X"]],1)`.
const enums = {};
for (const m of proto.matchAll(/[a-zA-Z_$][\w$]*\([a-zA-Z_$][\w$]*,[a-zA-Z_$][\w$]*,"([A-Za-z0-9_]+)",\[([\s\S]{0,4000}?)\],\d\)/g)) {
  const vals = [...m[2].matchAll(/\[(\d+),"([A-Z0-9_]+)"\]/g)].map((x) => `${x[1]}=${x[2]}`);
  if (vals.length) enums[m[1]] = vals;
}
write("proto-enums.json", enums);

// 4. Connector read-only tool sets: `[oh.<connector>,new Set(["tool",...])]`.
const connectors = {};
for (const g of mainApp.matchAll(/\[oh\.([A-Za-z0-9_]+),\s*new Set\(\[([\s\S]{20,6000}?)\]\)\]/g)) {
  const tools = [...g[2].matchAll(/"([a-zA-Z0-9_]+)"/g)].map((m) => m[1]);
  if (tools.length) connectors[g[1]] = [...new Set(tools)];
}
write("connector-readonly-tools.json", connectors);

// 5. Avatar palette. Anchored on array contents, not the minified variable names, so it
//    survives a rebuild: the shape list opens with blob/pebble/bean, the default pool with
//    blob/pebble/squircle, the colors with {id:"black"}, the expression states with a
//    {label:"Lifecycle",states:[...]} group.
const strList = (src) => [...src.matchAll(/"([a-z0-9_ -]+)"/gi)].map((x) => x[1]);
const shapeList = /\["blob","pebble","bean"[^\]]*\]/.exec(mainApp);
const poolList = /\["blob","pebble","squircle"[^\]]*\]/.exec(mainApp);
const colorList = /\[\{id:"black",label:"Black",value:"#000"\}[^\]]*\]/.exec(mainApp);
const stateGroups = [...mainApp.matchAll(/\{label:"([A-Za-z ]+)",states:\[([^\]]*)\]\}/g)];
if (!shapeList || !poolList || !colorList || stateGroups.length === 0) {
  console.error("avatar palette not found: the build layout changed, update the anchors above");
  process.exit(3);
}
write("avatar-palette.json", {
  shapes: strList(shapeList[0]),
  defaultShapePool: strList(poolList[0]),
  colors: [...colorList[0].matchAll(/\{id:"([a-z]+)",label:"([A-Za-z ]+)",value:"(#[0-9A-Fa-f]{3,6})"\}/g)].map((x) => ({
    id: x[1],
    label: x[2],
    value: x[3],
  })),
  states: Object.fromEntries(stateGroups.map((g) => [g[1], strList(g[2])])),
});

// 6. Flat method list.
write("grokbot-methods.txt", (services["aiserver.v1.GrokBotService"] ?? []).map((m) => m.name).sort().join("\n"));

console.log(
  `services=${Object.keys(services).length} methods=${Object.values(services).flat().length} ` +
    `shapes=${Object.keys(shapes).length} enums=${Object.keys(enums).length} connectors=${Object.keys(connectors).length}`,
);
