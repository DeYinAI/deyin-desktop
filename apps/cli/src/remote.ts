export interface RemoteRunOptions {
  url: string;
  prompt: string;
  json?: boolean;
  yes?: boolean;
  continueLast?: boolean;
  resumeId?: string;
  fork?: boolean;
  files?: string[];
  token?: string;
  username?: string;
  password?: string;
  signal?: AbortSignal;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  /** Receive decoded NDJSON events in addition to optional stream output. */
  onEvent?: (event: unknown) => void;
}

function write(stream: NodeJS.WritableStream, value: string): void {
  stream.write(value);
}

function endpoint(url: string): string {
  const base = url.endsWith("/") ? url : `${url}/`;
  return new URL("v1/run", base).toString();
}

function authHeader(opts: RemoteRunOptions): string | undefined {
  if (opts.token?.trim()) return `Bearer ${opts.token.trim()}`;
  if (opts.username !== undefined || opts.password !== undefined) {
    const value = Buffer.from(`${opts.username ?? "deyin"}:${opts.password ?? ""}`).toString("base64");
    return `Basic ${value}`;
  }
  return undefined;
}

/** Run a prompt through a DeYin `serve` endpoint, preserving its NDJSON events. */
export async function runRemote(options: RemoteRunOptions): Promise<number> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const headers: Record<string, string> = { "content-type": "application/json" };
  const authorization = authHeader(options);
  if (authorization) headers.authorization = authorization;
  let response: Response;
  try {
    response = await fetch(endpoint(options.url), {
      method: "POST",
      headers,
      body: JSON.stringify({
        prompt: options.prompt,
        yes: options.yes === true,
        continueLast: options.continueLast === true,
        resumeId: options.resumeId,
        fork: options.fork === true,
        files: options.files,
      }),
      signal: options.signal,
    });
  } catch (err) {
    write(stderr, `error: could not connect to ${options.url}: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  const body = response.body;
  if (!body) {
    write(stderr, `error: server returned an empty response (${response.status})\n`);
    return 1;
  }
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let pending = "";
  let exitCode = Number(response.headers.get("x-deyin-exit-code") ?? (response.ok ? "0" : "1"));
  const consume = (line: string): void => {
    if (!line.trim()) return;
    try {
      const event = JSON.parse(line) as { type?: string; delta?: string; finalText?: string; error?: string };
      options.onEvent?.(event);
      if (options.json) {
        write(stdout, `${line}\n`);
        return;
      }
      if (event.type === "text-delta" && typeof event.delta === "string") write(stdout, event.delta);
      if (event.type === "error" && typeof event.error === "string") write(stderr, `error: ${event.error}\n`);
    } catch {
      write(stderr, `${line}\n`);
    }
  };
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    pending += decoder.decode(next.value, { stream: true });
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) consume(line);
  }
  pending += decoder.decode();
  consume(pending);
  if (!Number.isInteger(exitCode)) exitCode = response.ok ? 0 : 1;
  return exitCode;
}
