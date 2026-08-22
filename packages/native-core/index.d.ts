export interface SseLineResult {
  payload: string | null;
  isDone: boolean;
}

export interface SseChunkResult {
  payloads: string[];
  rest: string;
  isDone: boolean;
}

export interface GrepMatch {
  file: string;
  lineNumber: number;
  lineText: string;
}

export interface GrepResult {
  matches: GrepMatch[];
  truncated: boolean;
}

export interface CompressResult {
  compressed: string;
  originalChars: number;
  compressedChars: number;
}

/**
 * Native hot-path bindings. `available` is false when the .node binary was not
 * built for this platform — callers must fall back to the TS implementations.
 */
export declare const available: boolean;
export declare function parseSseDataLine(line: string): SseLineResult | null;
export declare function frameSseChunk(buffer: string, chunk: string): SseChunkResult | null;
export declare function countTokens(text: string): number | null;
export declare function truncateToTokens(text: string, maxTokens: number): string | null;
export declare function compressWireText(content: string, mode: string): CompressResult | null;
export declare function compressWireTextEx(
  content: string,
  mode: string,
  toolName: string,
  preserveErrors: boolean,
): CompressResult | null;
export declare function grep(
  root: string,
  pattern: string,
  glob?: string,
  maxResults?: number,
  ignoreCase?: boolean,
): GrepResult | null;
