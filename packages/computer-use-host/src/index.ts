import { platform } from "node:os";
import { MockComputerUseHost, type ComputerUseHostApi } from "./host-api.js";
import { PipeComputerUseHost, resolveHostExe } from "./pipe-host.js";

export type { ComputerUseHostApi } from "./host-api.js";
export { MockComputerUseHost } from "./host-api.js";
export { PipeComputerUseHost, resolveHostExe } from "./pipe-host.js";

export interface CreateComputerUseHostOptions {
  resourcesPath?: string;
  shotsDir: string;
  signal?: AbortSignal;
}

export function createComputerUseHost(opts: CreateComputerUseHostOptions): ComputerUseHostApi {
  if (platform() !== "win32") return new MockComputerUseHost();
  const hostExe = resolveHostExe(opts.resourcesPath);
  return new PipeComputerUseHost({ hostExe, shotsDir: opts.shotsDir, signal: opts.signal });
}
