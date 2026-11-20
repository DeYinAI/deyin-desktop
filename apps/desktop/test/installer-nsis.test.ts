import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// build/installer.nsh re-skins electron-builder's one-click NSIS installer by hooking into
// documented-but-thin extension points (`customHeader`, `customCheckAppRunning`) and by
// replacing the stock app-running check. NSIS can't be compiled in this suite, so these tests
// pin the contract instead: if electron-builder moves any of the points we rely on, or the
// include stops honouring silent installs, we find out here rather than from a broken update.

const desktopDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const installerNsh = readFileSync(join(desktopDir, "build", "installer.nsh"), "utf8");

const require = createRequire(import.meta.url);
const builderRequire = createRequire(require.resolve("electron-builder/package.json"));
const nsisTemplates = join(dirname(builderRequire.resolve("app-builder-lib/package.json")), "templates", "nsis");

function template(...parts: string[]): string {
  return readFileSync(join(nsisTemplates, ...parts), "utf8");
}

/** Body of a top-level `!macro NAME ... !macroend` in installer.nsh. */
function macroBody(name: string): string {
  const match = new RegExp(`^!macro ${name}\\b[^\\n]*\\n([\\s\\S]*?)^!macroend`, "m").exec(installerNsh);
  assert.ok(match, `installer.nsh must define !macro ${name}`);
  return match[1] ?? "";
}

test("electron-builder still exposes the hooks installer.nsh relies on", () => {
  const one = template("installer.nsi");
  assert.match(one, /!ifmacrodef customHeader\s+!insertmacro customHeader/, "installer.nsi no longer calls customHeader");

  const running = template("include", "allowOnlyOneInstallerInstance.nsh");
  assert.match(running, /!ifmacrodef customCheckAppRunning\s+!insertmacro customCheckAppRunning/);
  assert.match(running, /!macro IS_POWERSHELL_AVAILABLE/, "IS_POWERSHELL_AVAILABLE moved; update customCheckAppRunning");
  assert.match(running, /!macro _CHECK_APP_RUNNING/, "_CHECK_APP_RUNNING moved; update customCheckAppRunning");
  // The stock include only declares `Var pid` when no custom check exists; ours must declare it.
  assert.match(running, /!ifmacrondef customCheckAppRunning[\s\S]*?Var pid/);

  const section = template("installSection.nsh");
  assert.match(section, /\$\{IfNot\} \$\{Silent\}\s+[\s\S]*?SpiderBanner::Show/, "banner is no longer silent-guarded/shown here");
  assert.match(section, /!insertmacro CHECK_APP_RUNNING/);
});

test("the stock app-running check is preserved, after the (non-silent only) restyle", () => {
  const body = macroBody("customCheckAppRunning");
  assert.match(body, /!insertmacro IS_POWERSHELL_AVAILABLE/);
  assert.match(body, /!insertmacro _CHECK_APP_RUNNING/);
  assert.ok(
    body.indexOf("DeyinStyleInstallWindow") < body.indexOf("_CHECK_APP_RUNNING"),
    "restyle must run before the check so any 'app is running' prompt appears in the new window",
  );
  assert.match(body, /\$\{IfNot\} \$\{Silent\}\s+Call DeyinStyleInstallWindow\s+\$\{EndIf\}/, "restyle must be skipped for /S installs");
  assert.match(body, /!ifndef BUILD_UNINSTALLER[\s\S]*Call DeyinStyleInstallWindow[\s\S]*!endif/, "uninstaller pass must not reference installer-only functions");
});

test("the window stays hidden until styled, but only when there is a window to show", () => {
  assert.match(installerNsh, /^!define MUI_CUSTOMFUNCTION_GUIINIT DeyinHideUntilStyled$/m);
  const header = macroBody("customHeader");
  const hide = /Function DeyinHideUntilStyled([\s\S]*?)FunctionEnd/.exec(header);
  assert.ok(hide, "DeyinHideUntilStyled must be defined in customHeader");
  assert.match(hide[1] ?? "", /\$\{IfNot\} \$\{Silent\}[\s\S]*SetLayeredWindowAttributes[\s\S]*\$\{EndIf\}/);

  // Every path that makes the window transparent must end by revealing it, or a bug here would
  // leave users with an invisible installer.
  const style = /Function DeyinStyleInstallWindow([\s\S]*?)FunctionEnd/.exec(header);
  assert.ok(style, "DeyinStyleInstallWindow must be defined in customHeader");
  assert.match(style[1] ?? "", /SetLayeredWindowAttributes\(p \$HWNDPARENT, i 0, i \$dyX, i 2\)/);
  assert.match(style[1] ?? "", /\$\{LoopUntil\} \$dyX == 255/);
});

test("the window is borderless: the title bar is removed before the client area is measured", () => {
  const style = /Function DeyinStyleInstallWindow([\s\S]*?)FunctionEnd/.exec(macroBody("customHeader"));
  assert.ok(style, "DeyinStyleInstallWindow must be defined in customHeader");
  const body = style[1] ?? "";
  // GWL_STYLE (-16) loses WS_CAPTION (0xC00000); GWL_EXSTYLE (-20) loses the dialog frame styles.
  assert.match(body, /IntOp \$dyY 0xC00000 ~/);
  assert.match(body, /SetWindowLong\(p \$HWNDPARENT, i -16, i \$dyX\)/);
  assert.match(body, /SetWindowLong\(p \$HWNDPARENT, i -20, i \$dyX\)/);
  assert.ok(
    body.indexOf("0xC00000") < body.indexOf("GetClientRect"),
    "frame must be stripped before GetClientRect, or the frame-size maths would still include a caption",
  );
});

test("the installer palette and logo are flat (no gradients)", () => {
  const flatSvg = readFileSync(join(desktopDir, "..", "..", "packages", "branding", "assets", "logo-mark-flat.svg"), "utf8");
  assert.doesNotMatch(flatSvg, /<(linear|radial)Gradient|url\(#/i, "installer logo must use solid colours");
  assert.match(installerNsh, /DEYIN_LOGO_FILE "\$\{BUILD_RESOURCES_DIR\}\\installer-mark\.ico"/);
  assert.ok(readFileSync(join(desktopDir, "build", "installer-mark.ico")).length > 0, "build/installer-mark.ico must be committed");
  const makeIcons = readFileSync(join(desktopDir, "..", "..", "packages", "branding", "scripts", "make-icons.mjs"), "utf8");
  assert.match(makeIcons, /installer-mark\.ico/, "make-icons must keep generating the installer logo");
});

test("installer-only code is fenced off from the uninstaller pass", () => {
  // electron-builder compiles this include twice and fails on NSIS warnings (unused Var/Function).
  const fenced = /^!ifndef BUILD_UNINSTALLER\n([\s\S]*?)^!endif\n\n!macro customCheckAppRunning/m.exec(installerNsh);
  assert.ok(fenced, "installer-only definitions must sit in one !ifndef BUILD_UNINSTALLER block before customCheckAppRunning");
  assert.match(fenced[1] ?? "", /!macro customHeader/);
  assert.match(fenced[1] ?? "", /^Var dyL$/m);
  assert.doesNotMatch(installerNsh.replace(fenced[0], ""), /^Var dy/m, "dy* variables must live inside the fence");
});
