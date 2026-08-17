#!/usr/bin/env node
/** Smoke-test the computer-use host factory (mock on non-Windows). */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createComputerUseHost } from "./index.js";

const host = createComputerUseHost({ shotsDir: join(tmpdir(), "deyin-cua-shots") });
const ok = await host.ping();
console.log(JSON.stringify({ ok, platform: process.platform }));
