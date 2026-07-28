import { render } from "ink";
import type { CliContext } from "../context.js";
import { App, type AppInitialState } from "./App.js";

/** Mount the Ink TUI and block until the user exits. */
export async function launchTui(ctx: CliContext, initial: AppInitialState = {}): Promise<number> {
  const instance = render(<App ctx={ctx} initial={initial} />, { exitOnCtrlC: false });
  await instance.waitUntilExit();
  return 0;
}
