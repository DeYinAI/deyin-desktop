/** Dependency-free ANSI helpers, honoring NO_COLOR and non-TTY output. */

const colorsEnabled = process.env.NO_COLOR === undefined && process.env.FORCE_COLOR !== "0" && Boolean(process.stdout.isTTY);

function wrap(open: number, close: number): (s: string) => string {
  return (s) => (colorsEnabled ? `\u001b[${open}m${s}\u001b[${close}m` : s);
}

export const bold = wrap(1, 22);
export const dim = wrap(2, 22);
export const italic = wrap(3, 23);
export const underline = wrap(4, 24);
export const red = wrap(31, 39);
export const green = wrap(32, 39);
export const yellow = wrap(33, 39);
export const blue = wrap(34, 39);
export const magenta = wrap(35, 39);
export const cyan = wrap(36, 39);
export const gray = wrap(90, 39);

export function errorLine(message: string): void {
  process.stderr.write(`${red("error:")} ${message}\n`);
}

export function noteLine(message: string): void {
  process.stderr.write(`${dim(message)}\n`);
}
