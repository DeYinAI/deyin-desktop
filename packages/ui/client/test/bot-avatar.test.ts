import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BOT_AVATAR_COLORS, BOT_AVATAR_SHAPES, BOT_AVATAR_STATES, botAvatarColorValue, botAvatarMarkValue, resolveBotAvatar, type BotAvatarShape, type BotAvatarState } from "@deyin/host-core/shared";
import { BotAvatar, MARK_REACH, type BotAvatarSource } from "../src/components/BotAvatar.js";
import { botAvatarBody } from "../src/components/botAvatarShapes.js";

function source(over: Partial<BotAvatarSource> = {}): BotAvatarSource {
  return { name: "Ada", avatarShape: "orb", avatarColor: "iris", ...over };
}

function render(bot: BotAvatarSource, props: { size?: number; state?: BotAvatarState; decorative?: boolean } = {}): string {
  return renderToStaticMarkup(createElement(BotAvatar, { bot, ...props }));
}

/** The form alone, without the mark, so forms can be compared. */
function body(html: string): string {
  const match = /<g fill="[^"]+" stroke="[^"]+"[^>]*>(.*?)<\/g>(?=<g data-part="mark">)/s.exec(html);
  assert.ok(match, `body found in ${html.slice(0, 160)}`);
  return match[1]!;
}

/** The mark alone, so states can be compared. */
function mark(html: string): string {
  const at = html.indexOf('<g data-part="mark">');
  assert.ok(at >= 0, "mark found");
  return html.slice(at);
}

function attr(tag: string, name: string): number {
  const match = new RegExp(`\\s${name}="(-?[\\d.]+)"`).exec(tag);
  assert.ok(match, `${name} in ${tag}`);
  return Number(match[1]);
}

type Point = [number, number];

/** The points of a path made of absolute M, L, H, V and Z commands. */
function pathPoints(d: string): Point[] {
  const points: Point[] = [];
  let x = 0;
  let y = 0;
  for (const [, command, args] of d.matchAll(/([MLHVZ])([^MLHVZ]*)/g)) {
    const n = (args ?? "").trim().split(/[\s,]+/).filter(Boolean).map(Number);
    if (command === "M" || command === "L") [x, y] = [n[0]!, n[1]!];
    else if (command === "H") x = n[0]!;
    else if (command === "V") y = n[0]!;
    else continue;
    points.push([x, y]);
  }
  return points;
}

function insidePolygon([px, py]: Point, polygon: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i]!;
    const [xj, yj] = polygon[j]!;
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function insideRoundedRect([px, py]: Point, tag: string): boolean {
  const [x, y, w, h, r] = [attr(tag, "x"), attr(tag, "y"), attr(tag, "width"), attr(tag, "height"), attr(tag, "rx")];
  if (px < x || px > x + w || py < y || py > y + h) return false;
  const cx = px < x + r ? x + r : px > x + w - r ? x + w - r : px;
  const cy = py < y + r ? y + r : py > y + h - r ? y + h - r : py;
  return Math.hypot(px - cx, py - cy) <= r;
}

/** Whether a point lies inside a form, from the form's own markup. */
function insideBody(shape: BotAvatarShape, point: Point): boolean {
  const markup = renderToStaticMarkup(botAvatarBody(shape));
  const circles = [...markup.matchAll(/<circle [^>]*>/g)].map((m) => m[0]);
  if (shape === "petal") {
    // One square corner and three arcs of a circle of radius 42 about the center: the circle plus the corner square.
    const [x, y] = point;
    return Math.hypot(x - 50, y - 50) <= 42 || (x >= 50 && x <= 92 && y >= 8 && y <= 50);
  }
  if (circles.length > 0) return circles.some((c) => Math.hypot(point[0] - attr(c, "cx"), point[1] - attr(c, "cy")) <= attr(c, "r"));
  const rect = /<rect [^>]*>/.exec(markup);
  if (rect) {
    const turn = /rotate\((-?[\d.]+) 50 50\)/.exec(rect[0]);
    const back = turn ? (-Number(turn[1]) * Math.PI) / 180 : 0;
    const [dx, dy] = [point[0] - 50, point[1] - 50];
    return insideRoundedRect([50 + dx * Math.cos(back) - dy * Math.sin(back), 50 + dx * Math.sin(back) + dy * Math.cos(back)], rect[0]);
  }
  const path = /<path d="([^"]+)"/.exec(markup);
  assert.ok(path, `${shape} has an outline`);
  return insidePolygon(point, pathPoints(path[1]!));
}

test("every one of the 10 designed forms draws something", () => {
  assert.equal(BOT_AVATAR_SHAPES.length, 10);
  for (const shape of BOT_AVATAR_SHAPES) {
    const html = render(source({ avatarShape: shape }));
    assert.match(html, new RegExp(`data-shape="${shape}"`), shape);
    assert.match(body(html), /<(path|circle|rect)\b/, `${shape} has geometry`);
  }
});

test("no two forms share a silhouette", () => {
  const seen = new Map<string, BotAvatarShape>();
  for (const shape of BOT_AVATAR_SHAPES) {
    const outline = body(render(source({ avatarShape: shape })));
    const clash = seen.get(outline);
    assert.equal(clash, undefined, `${shape} duplicates ${clash}`);
    seen.set(outline, shape);
  }
});

test("every form contains the whole disc the mark is drawn inside", () => {
  for (const shape of BOT_AVATAR_SHAPES) {
    assert.ok(insideBody(shape, [50, 50]), `${shape} holds its center`);
    for (let degrees = 0; degrees < 360; degrees += 5) {
      const rad = (degrees * Math.PI) / 180;
      const point: Point = [50 + MARK_REACH * Math.cos(rad), 50 + MARK_REACH * Math.sin(rad)];
      assert.ok(insideBody(shape, point), `${shape} holds the mark disc at ${degrees} degrees`);
    }
  }
});

test("no part of any state's mark reaches outside that disc", () => {
  for (const state of BOT_AVATAR_STATES) {
    const html = mark(render(source(), { state }));
    for (const [circle] of html.matchAll(/<circle [^>]*>/g)) {
      const stroke = circle.includes("fill=\"none\"") ? attr(circle, "stroke-width") / 2 : 0;
      const reach = Math.hypot(attr(circle, "cx") - 50, attr(circle, "cy") - 50) + attr(circle, "r") + stroke;
      assert.ok(reach <= MARK_REACH + 0.02, `${state}: ${circle} reaches ${reach}`);
    }
    for (const [, d] of html.matchAll(/<path [^>]*\bd="([^"]+)"/g)) {
      for (const [x, y] of pathPoints(d!)) assert.ok(Math.hypot(x - 50, y - 50) <= MARK_REACH, `${state}: path point ${x},${y}`);
    }
    for (const [rect] of html.matchAll(/<rect [^>]*>/g)) {
      const [x, y, w, h] = [attr(rect, "x"), attr(rect, "y"), attr(rect, "width"), attr(rect, "height")];
      for (const corner of [[x, y], [x + w, y], [x, y + h], [x + w, y + h]] as Point[]) {
        assert.ok(Math.hypot(corner[0] - 50, corner[1] - 50) <= MARK_REACH, `${state}: rect corner ${corner}`);
      }
    }
  }
});

test("each palette color fills the form with its own value", () => {
  for (const color of BOT_AVATAR_COLORS) {
    const html = render(source({ avatarColor: color.id }));
    assert.match(html, new RegExp(`<g fill="${color.value}" stroke="${color.value}"`), color.id);
  }
});

test("the mark is drawn in whichever of ink and white reads better on the color", () => {
  for (const color of BOT_AVATAR_COLORS) {
    const html = mark(render(source({ avatarColor: color.id })));
    assert.match(html, new RegExp(`(stroke|fill)="${botAvatarMarkValue(color.id)}"`), color.id);
    assert.doesNotMatch(html, new RegExp(`(stroke|fill)="${color.value}"`), `${color.id} mark is not its own color`);
  }
  assert.match(mark(render(source({ avatarColor: "periwinkle" }))), /fill="#10131a"/);
  assert.match(mark(render(source({ avatarColor: "ink" }))), /fill="#ffffff"/);
});

test("an unknown color or form draws a valid palette color and form instead of nothing or throwing", () => {
  const html = render(source({ avatarShape: "pumpkin" as never, avatarColor: "chartreuse" as never }));
  const shape = /data-shape="([^"]+)"/.exec(html)![1]!;
  assert.ok((BOT_AVATAR_SHAPES as readonly string[]).includes(shape), shape);
  const fill = /<g fill="([^"]+)"/.exec(html)![1]!;
  assert.ok(BOT_AVATAR_COLORS.some((c) => c.value === fill), fill);
});

test("every state has a mark, and the marks differ", () => {
  const marks = new Map<string, BotAvatarState>();
  for (const state of BOT_AVATAR_STATES) {
    const html = render(source(), { state });
    assert.match(html, new RegExp(`bot-avatar--${state}`), state);
    const drawn = mark(html);
    const clash = marks.get(drawn);
    assert.equal(clash, undefined, `${state} looks like ${clash}`);
    marks.set(drawn, state);
  }
});

test("a Bot with a form and color from before the redesign draws as their mapped replacements", () => {
  const html = render(source({ avatarShape: "star" as never, avatarColor: "violet" as never }));
  const replacement = resolveBotAvatar({ id: "Ada", avatarShape: "star", avatarColor: "violet" });
  assert.match(html, new RegExp(`data-shape="${replacement.shape}"`));
  assert.match(html, new RegExp(`<g fill="${botAvatarColorValue(replacement.color)}"`));
});

test("the default state is idle", () => {
  assert.equal(render(source()), render(source(), { state: "idle" }));
});

test("states that mean something carry a distinguishing part, not just a different dot position", () => {
  assert.match(render(source(), { state: "failed" }), /data-part="cross"/);
  assert.match(render(source(), { state: "failed" }), /data-part="orbit-broken"/);
  assert.doesNotMatch(render(source(), { state: "failed" }), /data-part="orbit"/);
  assert.match(render(source(), { state: "finished" }), /data-part="check"/);
  assert.match(render(source(), { state: "sleeping" }), /data-part="z"/);
  assert.match(render(source(), { state: "waiting" }), /stroke-dasharray="4 5"/);
  assert.match(render(source(), { state: "blocked" }), /data-part="bar"/);
  assert.match(render(source(), { state: "working" }), /data-part="trail"/);
  assert.doesNotMatch(render(source(), { state: "idle" }), /data-part="trail"/);
});

test("the dot always sits in a spin group, so the stylesheet can send it round the orbit", () => {
  for (const state of BOT_AVATAR_STATES) {
    assert.match(render(source(), { state }), /<g data-part="spin">.*data-part="dot"/s, state);
  }
});

test("the size sets the rendered edge but not the drawing, so avatars scale cleanly", () => {
  const small = render(source(), { size: 20 });
  const big = render(source(), { size: 64 });
  assert.match(small, /width="20" height="20"/);
  assert.match(big, /width="64" height="64"/);
  assert.match(small, /viewBox="0 0 100 100"/);
  assert.equal(small.replace(/width="20" height="20"/, ""), big.replace(/width="64" height="64"/, ""));
});

test("an avatar is announced by the Bot's name, or hidden from assistive tech beside the name", () => {
  const named = render(source({ name: "Ada" }));
  assert.match(named, /role="img"/);
  assert.match(named, /aria-label="Ada"/);
  const decorative = render(source({ name: "Ada" }), { decorative: true });
  assert.match(decorative, /aria-hidden="true"/);
  assert.doesNotMatch(decorative, /aria-label/);
  assert.doesNotMatch(decorative, /role="img"/);
});

test("a Bot name is escaped, never injected, into the label", () => {
  const html = render(source({ name: '"><script>alert(1)</script>' }));
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /aria-label="&quot;&gt;&lt;script&gt;/);
});

test("an uploaded image replaces the form and mark entirely", () => {
  const url = "data:image/png;base64,AAAA";
  const html = render(source({ avatarUrl: url, name: "Ada" }), { size: 40 });
  assert.match(html, /^<img /);
  assert.match(html, /src="data:image\/png;base64,AAAA"/);
  assert.match(html, /width="40" height="40"/);
  assert.match(html, /alt="Ada"/);
  assert.doesNotMatch(html, /<svg/);
});

test("a decorative uploaded image has empty alt and is hidden from assistive tech", () => {
  const html = render(source({ avatarUrl: "data:image/png;base64,AAAA" }), { decorative: true });
  assert.match(html, /alt=""/);
  assert.match(html, /aria-hidden="true"/);
});

test("an empty avatarUrl does not count as an upload", () => {
  assert.match(render(source({ avatarUrl: "" })), /^<svg /);
});
