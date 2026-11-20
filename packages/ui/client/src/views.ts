/**
 * The top-level views of the app shell.
 *
 * A view is what the center column shows. Some belong to one product's own shell
 * (`workspace` is Deyin Code's chat, `conductor` and `workflows` are Deyin Conductor's,
 * `bot`, `botDetail` and `botMarket` are Deyin Bot's); the rest are shared chrome that any product
 * can open and that must not change which product the user is in.
 */
export type View =
  | "workspace"
  | "settings"
  | "upgrade"
  | "automations"
  | "plugins"
  | "superagent"
  | "conductor"
  | "workflows"
  | "bot"
  | "botDetail"
  | "botMarket";

/**
 * Where opening a right-panel tab leaves the center column. The panel is about the conversation, so it
 * surfaces the one the user is in: Conductor stays Conductor, a Bot's page returns to that Bot's chat,
 * and everything else goes to the Code workspace.
 */
export function viewAfterPanelOpen(current: View): View {
  switch (current) {
    case "conductor":
      return "conductor";
    case "bot":
    case "botDetail":
    case "botMarket":
      return "bot";
    case "workspace":
    case "settings":
    case "upgrade":
    case "automations":
    case "plugins":
    case "superagent":
    case "workflows":
      return "workspace";
    default: {
      const unhandled: never = current;
      throw new Error(`Unhandled view: ${String(unhandled)}`);
    }
  }
}
