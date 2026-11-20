/**
 * Pages for the computer-use overlay windows. They are static strings loaded as data URLs in sandboxed windows
 * with no preload: the main process pushes state in with `window.__set` / `window.__cue`, and the pill's buttons
 * report back by logging a line that starts with OVERLAY_ACTION_PREFIX (read from the console-message event).
 */

export const OVERLAY_ACTION_PREFIX = "deyin-overlay:";

/** Brand accent while the agent is in control, and amber when the user took over. */
const ACCENT = "124, 92, 255";
const PAUSED = "245, 166, 35";

/** Transparent full-display page: a glowing edge, and a ripple where the agent is about to click. */
export function overlayBorderHtml(): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title></title>
<style>
  html, body { margin: 0; height: 100%; background: transparent; overflow: hidden; cursor: none; }
  #frame {
    --c: ${ACCENT};
    position: fixed; inset: 0; pointer-events: none; opacity: 0; transition: opacity .25s ease;
    box-shadow: inset 0 0 0 3px rgba(var(--c), .9), inset 0 0 36px rgba(var(--c), .55), inset 0 0 110px rgba(var(--c), .22);
    animation: pulse 2.2s ease-in-out infinite;
  }
  body.input #frame { opacity: 1; }
  body.paused #frame { --c: ${PAUSED}; opacity: 1; animation: none; }
  @keyframes pulse { 0%, 100% { filter: brightness(1); } 50% { filter: brightness(1.35); } }
  .ripple, .dot { position: fixed; pointer-events: none; border-radius: 50%; }
  .ripple { width: 18px; height: 18px; margin: -9px 0 0 -9px; border: 2px solid rgba(${ACCENT}, .95); animation: ripple .9s ease-out forwards; }
  .dot { width: 12px; height: 12px; margin: -6px 0 0 -6px; background: rgba(${ACCENT}, .95); box-shadow: 0 0 14px rgba(${ACCENT}, .9); animation: dot 1.1s ease-out forwards; }
  @keyframes ripple { from { transform: scale(.4); opacity: 1; } to { transform: scale(4.2); opacity: 0; } }
  @keyframes dot { 0% { opacity: 0; transform: scale(.4); } 20% { opacity: 1; transform: scale(1); } 80% { opacity: 1; } 100% { opacity: 0; } }
</style></head>
<body><div id="frame"></div>
<script>
  window.__set = function (state) {
    document.body.className = state.phase === 'input' || state.phase === 'paused' ? state.phase : '';
  };
  window.__cue = function (x, y) {
    ['dot', 'ripple'].forEach(function (kind) {
      var el = document.createElement('div');
      el.className = kind;
      el.style.left = x + 'px';
      el.style.top = y + 'px';
      document.body.appendChild(el);
      setTimeout(function () { el.remove(); }, 1200);
    });
  };
</script></body></html>`;
}

/** The pill: what Deyin is doing, with Stop (and Resume after a takeover). */
export function overlayPillHtml(): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title></title>
<style>
  html, body { margin: 0; background: transparent; overflow: hidden; user-select: none;
    font: 13px/1 "Segoe UI", system-ui, sans-serif; color: #f5f5f7; }
  #pill {
    box-sizing: border-box; margin: 4px; height: 44px; display: flex; align-items: center; gap: 10px;
    padding: 0 8px 0 14px; border-radius: 22px; background: rgba(24, 24, 28, .94);
    /* The window is the pill plus a 4px margin, and anything outside it is cut off, so the shadow must stay
       inside that margin (1px offset + 3px blur): a larger one ends in a visible grey rectangle. */
    border: 1px solid rgba(255, 255, 255, .12); box-shadow: 0 1px 3px rgba(0, 0, 0, .4);
  }
  #dot { flex: none; width: 9px; height: 9px; border-radius: 50%; background: rgb(${ACCENT});
    box-shadow: 0 0 10px rgb(${ACCENT}); animation: blink 1.4s ease-in-out infinite; }
  .paused #dot { background: rgb(${PAUSED}); box-shadow: 0 0 10px rgb(${PAUSED}); animation: none; }
  .idle #dot { animation: none; opacity: .6; }
  @keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: .45; } }
  #label { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  button { all: unset; cursor: pointer; padding: 7px 12px; border-radius: 14px; font-weight: 600; background: rgba(255, 255, 255, .1); }
  button:hover { background: rgba(255, 255, 255, .2); }
  button.stop { background: #e5484d; color: #fff; }
  button.stop:hover { background: #f2555a; }
  #resume { display: none; }
  .paused #resume { display: inline-block; }
</style></head>
<body>
<div id="pill" class="idle">
  <span id="dot"></span><span id="label"></span>
  <button id="resume" type="button">Resume</button>
  <button id="stop" class="stop" type="button">Stop</button>
</div>
<script>
  function act(name) { console.info('${OVERLAY_ACTION_PREFIX}' + name); }
  document.getElementById('resume').addEventListener('click', function () { act('resume'); });
  document.getElementById('stop').addEventListener('click', function () { act('stop'); });
  window.__set = function (state) {
    document.getElementById('pill').className = state.phase;
    document.getElementById('label').textContent = state.label;
    document.getElementById('stop').title = 'Stop (' + state.chord + ')';
  };
</script></body></html>`;
}
