import type {
  ActionResult,
  AppInfo,
  DisplayInfo,
  LaunchResult,
  Rect,
  UiNode,
  WindowInfo,
  WindowState,
} from "@deyin/computer-use-host";

const MAX_VALUE_CHARS = 80;
const MAX_NAME_CHARS = 120;

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function rect(r: Rect): string {
  return `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}`;
}

function windowFlags(w: WindowInfo): string[] {
  const flags: string[] = [];
  if (w.foreground) flags.push("foreground");
  if (w.minimized) flags.push("minimized");
  if (w.elevated) flags.push("administrator (input cannot reach it)");
  return flags;
}

export function formatWindowLine(w: WindowInfo): string {
  const flags = windowFlags(w);
  const where = w.displayId ? ` on display ${w.displayId}` : "";
  const scale = w.dpiScale && w.dpiScale !== 1 ? `, ${Math.round(w.dpiScale * 100)}% scale` : "";
  return `${w.id} | ${w.app || "?"} | "${clip(w.title, MAX_NAME_CHARS)}" | pid ${w.pid} | ${rect(w.bounds)}${where}${scale}${flags.length ? ` | ${flags.join(", ")}` : ""}`;
}

export function formatWindows(windows: WindowInfo[]): string {
  if (windows.length === 0) return "No windows are open.";
  return [`${windows.length} windows (id | app | title | pid | x,y WxH in screen pixels):`, ...windows.map(formatWindowLine)].join("\n");
}

export function formatApps(apps: AppInfo[]): string {
  if (apps.length === 0) return "No applications found.";
  return [`${apps.length} apps (id | name):`, ...apps.map((a) => `${a.id} | ${a.name}`)].join("\n");
}

export function formatDisplays(displays: DisplayInfo[]): string {
  if (displays.length === 0) return "No displays found.";
  return [
    `${displays.length} display(s). Screen coordinates are physical pixels on one virtual desktop:`,
    ...displays.map(
      (d) =>
        `${d.id}${d.primary ? " (primary)" : ""} | ${d.name} | ${rect(d)} | work area ${rect({ x: d.workX, y: d.workY, width: d.workWidth, height: d.workHeight })} | ${Math.round(d.scale * 100)}% scale (${d.dpi} dpi)`,
    ),
  ].join("\n");
}

function nodeFlags(n: UiNode): string {
  const parts: string[] = [];
  if (n.enabled === false) parts.push("disabled");
  if (n.focused) parts.push("focused");
  if (n.selected) parts.push("selected");
  if (n.toggled) parts.push(`toggled=${n.toggled}`);
  if (n.expanded) parts.push(`expanded=${n.expanded}`);
  if (n.password) parts.push("password");
  return parts.length ? ` (${parts.join(", ")})` : "";
}

export function formatNode(n: UiNode, baseDepth = 0): string {
  const indent = "  ".repeat(Math.max(0, n.depth - baseDepth));
  const name = n.name ? ` "${clip(n.name, MAX_NAME_CHARS)}"` : "";
  // A password field's contents are never put in front of the model.
  const value = n.value && !n.password ? ` value="${clip(n.value, MAX_VALUE_CHARS)}"` : "";
  const id = n.id ? ` #${n.id}` : "";
  return `${indent}${n.ref} ${n.role}${name}${value}${id} [${rect(n.bounds)}]${nodeFlags(n)}`;
}

/**
 * What the model reads after `computer_get_state`: where the window is, the screenshot (path, size and the
 * coordinate space for x/y arguments), and a compact indented outline of the elements with their refs.
 */
export function formatWindowState(state: WindowState): string {
  const lines: string[] = [`Window ${formatWindowLine(state.window)}`];

  const shot = state.screenshot;
  if (shot) {
    if (shot.path) {
      lines.push(
        `Screenshot: ${shot.path} (${shot.width}x${shot.height}${shot.scale !== 1 ? `, scale ${shot.scale.toFixed(2)}` : ""}, ${shot.method}).`,
      );
      lines.push("Coordinates for x/y arguments are pixels in this image, measured from the window's top-left corner.");
    } else {
      lines.push(`No screenshot: ${shot.note ?? "the window could not be captured."}`);
    }
    if (shot.path && shot.note) lines.push(`Screenshot note: ${shot.note}`);
  }

  const tree = state.tree;
  if (tree) {
    const base = tree.nodes.reduce((min, n) => Math.min(min, n.depth), Number.POSITIVE_INFINITY);
    const baseDepth = Number.isFinite(base) ? base : 0;
    const kept = `${tree.nodes.length} element${tree.nodes.length === 1 ? "" : "s"}`;
    lines.push(
      `Elements (observation ${tree.stateId}, ${kept}${tree.truncated ? `, truncated after visiting ${tree.visited}` : ""}). Use a ref in later actions; refs from older observations are rejected:`,
    );
    for (const node of tree.nodes) lines.push(formatNode(node, baseDepth));
    if (tree.note) lines.push(`Note: ${tree.note}`);
  } else if (state.treeError) {
    lines.push(`Elements unavailable: ${state.treeError}`);
  }
  return lines.join("\n");
}

/** One line telling the model what happened, including whether the user's own mouse or focus was touched. */
export function formatAction(result: ActionResult, what: string): string {
  const touched: string[] = [];
  if (result.cursorMoved) touched.push("moved the pointer");
  if (result.focusChanged) touched.push("changed the focused window");
  const side =
    result.method === "input"
      ? touched.length
        ? `used the real mouse/keyboard; ${touched.join(" and ")}, then put it back`
        : "used the real mouse/keyboard"
      : touched.length
        ? `${touched.join(" and ")}, then put it back`
        : "did not touch the user's mouse or focus";
  const detail = result.detail ? ` — ${result.detail}` : "";
  const status = result.ok ? "OK" : "FAILED";
  return `${status}: ${what} via ${result.method} (${side})${detail}`;
}

export function formatLaunch(result: LaunchResult): string {
  if (result.window) {
    return `Launched ${result.launched} (pid ${result.pid}). Window ${formatWindowLine(result.window)}`;
  }
  if (result.windowId) return `Launched ${result.launched} (pid ${result.pid}), window id ${result.windowId}.`;
  return `Launched ${result.launched} (pid ${result.pid}), but no window appeared yet. Call computer_list_windows in a moment.`;
}
