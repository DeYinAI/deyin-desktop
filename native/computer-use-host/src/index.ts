import { platform } from "node:os";
import { MockComputerUseHost, type ComputerUseHostApi } from "./host-api.js";
import { PipeComputerUseHost, resolveHostExe } from "./pipe-host.js";

export { MockComputerUseHost } from "./host-api.js";
export type * from "./host-api.js";
export { PipeComputerUseHost, HostCancelledError, HostRpcError, resolveHostExe, hostLogPath } from "./pipe-host.js";
export { RPC_CODES, METHOD_TIMEOUT_MS, PIPE_NAME } from "./protocol.js";

export interface CreateComputerUseHostOptions {
  resourcesPath?: string;
  shotsDir: string;
  logPath?: string;
  signal?: AbortSignal;
}

export function createComputerUseHost(opts: CreateComputerUseHostOptions): ComputerUseHostApi {
  if (platform() !== "win32") return new MockComputerUseHost();
  const hostExe = resolveHostExe(opts.resourcesPath);
  return new PipeComputerUseHost({ hostExe, shotsDir: opts.shotsDir, logPath: opts.logPath, signal: opts.signal });
}
