import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export type ResponseScript = (requestIndex: number, body: Record<string, unknown>) => unknown[];

/**
 * Minimal OpenAI-compatible /chat/completions mock. The script returns the SSE chunk
 * objects for each request (in order); [DONE] is appended automatically.
 */
export async function startMockOpenAI(script: ResponseScript): Promise<{
  url: string;
  requests: Record<string, unknown>[];
  close: () => Promise<void>;
}> {
  const requests: Record<string, unknown>[] = [];
  const server = createServer((req, res) => {
    if (!req.url?.endsWith("/chat/completions")) {
      res.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      const index = requests.length;
      requests.push(body);
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const event of script(index, body)) {
        res.write(`data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`);
      }
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

export const textResponse = (text: string): unknown[] => [
  { choices: [{ delta: { content: text } }] },
  { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
];

export const toolCallResponse = (id: string, name: string, args: object): unknown[] => [
  {
    choices: [
      { delta: { tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }] } },
    ],
  },
  { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
];

/** Multiple tool_calls in one completion (parallel batch). */
export const multiToolCallResponse = (
  calls: { id: string; name: string; args: object }[],
): unknown[] => [
  {
    choices: [
      {
        delta: {
          tool_calls: calls.map((c, index) => ({
            index,
            id: c.id,
            type: "function",
            function: { name: c.name, arguments: JSON.stringify(c.args) },
          })),
        },
      },
    ],
  },
  { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
];
