import assert from "node:assert/strict";
import test from "node:test";
import { AVATAR_GENERATED_BUDGET, AVATAR_IMAGE_PIXELS, type BotAvatarPicture, type SquareCrop } from "@deyin/host-core";
import {
  createAvatarHandlers,
  shrinkToAvatar,
  type AvatarGenerateDeps,
  type DecodedPicture,
  type RawPicture,
} from "../src/main/bots/avatar-generate.js";

interface Fake {
  decoded: DecodedPicture;
  calls: string[];
}

/** A picture that records what was done to it. `png` and `jpeg` are the bytes each encoding produces. */
function fakePicture(options: { width: number; height: number; empty?: boolean; png: number; jpeg?: Record<number, number> }): Fake {
  const calls: string[] = [];
  const make = (width: number, height: number): DecodedPicture => ({
    isEmpty: () => options.empty === true,
    getSize: () => ({ width, height }),
    crop: (rect: SquareCrop) => {
      calls.push(`crop ${rect.x},${rect.y},${rect.width}x${rect.height}`);
      return make(rect.width, rect.height);
    },
    resize: (size) => {
      calls.push(`resize ${size.width}x${size.height}`);
      return make(size.width, size.height);
    },
    toPNG: () => {
      calls.push("png");
      return Buffer.alloc(options.png, 7);
    },
    toJPEG: (quality) => {
      calls.push(`jpeg ${quality}`);
      return Buffer.alloc(options.jpeg?.[quality] ?? 1, 9);
    },
  });
  return { decoded: make(options.width, options.height), calls };
}

const RAW: RawPicture = { base64: Buffer.from("not read by the fake").toString("base64"), mediaType: "image/png" };
/** The most bytes whose PNG data URL still fits in `urlChars`: 4 characters for every 3 bytes after a 22-character head. */
const bytesFor = (urlChars: number): number => Math.floor((urlChars - 22) / 4) * 3;

test("a large picture is cropped to its middle square, then resized to the avatar size", () => {
  const fake = fakePicture({ width: 1200, height: 1000, png: 100 });
  const result = shrinkToAvatar(RAW, () => fake.decoded);
  assert.deepEqual(fake.calls, ["crop 100,0,1000x1000", `resize ${AVATAR_IMAGE_PIXELS}x${AVATAR_IMAGE_PIXELS}`, "png"]);
  assert.match(result.url, /^data:image\/png;base64,/);
});

test("a picture already at or under the avatar size is cropped but not resized", () => {
  const exact = fakePicture({ width: 256, height: 256, png: 100 });
  shrinkToAvatar(RAW, () => exact.decoded);
  assert.deepEqual(exact.calls, ["crop 0,0,256x256", "png"]);
  const small = fakePicture({ width: 100, height: 140, png: 100 });
  shrinkToAvatar(RAW, () => small.decoded);
  assert.deepEqual(small.calls, ["crop 0,20,100x100", "png"]);
  const over = fakePicture({ width: 257, height: 257, png: 100 });
  shrinkToAvatar(RAW, () => over.decoded);
  assert.ok(over.calls.includes("resize 256x256"));
});

test("the bytes of the base64 are what is decoded", () => {
  let seen = "";
  const fake = fakePicture({ width: 10, height: 10, png: 10 });
  shrinkToAvatar({ base64: Buffer.from("abc").toString("base64"), mediaType: "image/webp" }, (bytes) => {
    seen = bytes.toString("utf8");
    return fake.decoded;
  });
  assert.equal(seen, "abc");
});

test("a picture the platform cannot decode is refused with a readable reason", () => {
  const fake = fakePicture({ width: 0, height: 0, empty: true, png: 1 });
  assert.throws(() => shrinkToAvatar(RAW, () => fake.decoded), /did not return a picture/);
  assert.deepEqual(fake.calls, []);
});

test("a PNG exactly at the budget is kept, and one over it falls back to a JPEG", () => {
  // The budget is on the data URL's length, which the byte count decides in steps of three bytes.
  const atBudget = bytesFor(AVATAR_GENERATED_BUDGET);
  const fits = fakePicture({ width: 256, height: 256, png: atBudget });
  const kept = shrinkToAvatar(RAW, () => fits.decoded);
  assert.ok(kept.url.length <= AVATAR_GENERATED_BUDGET && kept.url.length > AVATAR_GENERATED_BUDGET - 4, String(kept.url.length));
  assert.match(kept.url, /^data:image\/png/);
  assert.ok(!fits.calls.some((call) => call.startsWith("jpeg")));

  const tooBig = fakePicture({ width: 256, height: 256, png: atBudget + 3, jpeg: { 85: 500 } });
  const fallback = shrinkToAvatar(RAW, () => tooBig.decoded);
  assert.match(fallback.url, /^data:image\/jpeg/);
  assert.deepEqual(tooBig.calls.filter((call) => call.startsWith("jpeg")), ["jpeg 85"]);
});

test("a JPEG is tried at three qualities, best first, and the first that fits is used", () => {
  const big = bytesFor(AVATAR_GENERATED_BUDGET) + 300;
  const fake = fakePicture({ width: 256, height: 256, png: big, jpeg: { 85: big, 70: big, 55: 400 } });
  const result = shrinkToAvatar(RAW, () => fake.decoded);
  assert.deepEqual(fake.calls.filter((call) => call.startsWith("jpeg")), ["jpeg 85", "jpeg 70", "jpeg 55"]);
  assert.match(result.url, /^data:image\/jpeg/);
});

test("a picture that fits no way is refused, not saved over the limit", () => {
  const big = bytesFor(AVATAR_GENERATED_BUDGET) + 300;
  const fake = fakePicture({ width: 256, height: 256, png: big, jpeg: { 85: big, 70: big, 55: big } });
  assert.throws(() => shrinkToAvatar(RAW, () => fake.decoded), /too detailed/);
});

function deps(overrides: Partial<AvatarGenerateDeps> = {}): AvatarGenerateDeps & { requests: Array<{ prompt: string; model: string; providerId?: string }> } {
  const requests: Array<{ prompt: string; model: string; providerId?: string }> = [];
  return {
    requests,
    generate: async (request) => {
      requests.push(request);
      return RAW;
    },
    shrink: (): BotAvatarPicture => ({ url: "data:image/png;base64,AAAA" }),
    ...overrides,
  };
}

test("a request becomes a picture, made from the person's words with the Bot's name", async () => {
  const d = deps();
  const result = await createAvatarHandlers(d).generate({ prompt: "a fox", model: "flux-1", providerId: "mine", botName: "Rex" });
  assert.deepEqual(result, { ok: true, value: { url: "data:image/png;base64,AAAA" } });
  assert.equal(d.requests.length, 1);
  assert.equal(d.requests[0]!.model, "flux-1");
  assert.equal(d.requests[0]!.providerId, "mine");
  assert.match(d.requests[0]!.prompt, /^a fox/);
  assert.match(d.requests[0]!.prompt, /called "Rex"/);
});

test("a request with no provider asks for none, and a name that is not text is ignored", async () => {
  const d = deps();
  await createAvatarHandlers(d).generate({ prompt: "a fox", model: "flux-1", botName: 12 });
  assert.equal("providerId" in d.requests[0]!, false);
  assert.doesNotMatch(d.requests[0]!.prompt, /called/);
});

test("nothing reaches the model unless the request is complete and sane", async () => {
  const d = deps();
  const handlers = createAvatarHandlers(d);
  const bad: unknown[] = [
    null,
    "a fox",
    [],
    42,
    {},
    { model: "m" },
    { prompt: "   ", model: "m" },
    { prompt: "a".repeat(301), model: "m" },
    { prompt: "a fox" },
    { prompt: "a fox", model: "" },
    { prompt: "a fox", model: 7 },
    { prompt: "a fox", model: "m".repeat(201) },
    { prompt: "a fox", model: "bad\nmodel" },
    { prompt: "a fox", model: "m", providerId: "" },
    { prompt: "a fox", model: "m", providerId: 3 },
    { prompt: "a fox", model: "m", providerId: "p\u0000" },
  ];
  for (const input of bad) {
    const result = await handlers.generate(input);
    assert.equal(result.ok, false, JSON.stringify(input));
    if (!result.ok) assert.equal(result.code, "invalid");
  }
  assert.equal(d.requests.length, 0);
});

test("a request that is not an object is refused for that, not for something it never had", async () => {
  const handlers = createAvatarHandlers(deps());
  for (const input of [null, undefined, "a fox", 42, true, [], [{ prompt: "a fox", model: "m" }]]) {
    assert.deepEqual(await handlers.generate(input), { ok: false, error: "The picture request must be an object.", code: "invalid" }, JSON.stringify(input));
  }
});

test("a refusal of exactly 200 characters is shown whole and one of 201 is cut to 199 and a mark", async () => {
  for (const [length, expected] of [
    [200, "y".repeat(200)],
    [201, `${"y".repeat(199)}…`],
  ] as const) {
    const handlers = createAvatarHandlers(
      deps({
        generate: async () => {
          throw new Error("y".repeat(length));
        },
      }),
    );
    const result = await handlers.generate({ prompt: "a fox", model: "m" });
    assert.deepEqual(result, { ok: false, error: expected, code: "invalid" });
  }
});

test("a model of exactly 200 characters is allowed", async () => {
  const d = deps();
  const result = await createAvatarHandlers(d).generate({ prompt: "a fox", model: "m".repeat(200) });
  assert.equal(result.ok, true);
});

test("a refusal from the model comes back as its first line, shortened, and the next request is allowed", async () => {
  let attempt = 0;
  const d = deps({
    generate: async () => {
      attempt += 1;
      if (attempt === 1) throw new Error(`Signed out — sign in to Openference to generate images.\n${"stack ".repeat(100)}`);
      if (attempt === 2) throw new Error("x".repeat(500));
      return RAW;
    },
  });
  const handlers = createAvatarHandlers(d);
  const first = await handlers.generate({ prompt: "a fox", model: "m" });
  assert.deepEqual(first, { ok: false, error: "Signed out — sign in to Openference to generate images.", code: "invalid" });
  const second = await handlers.generate({ prompt: "a fox", model: "m" });
  assert.equal(second.ok, false);
  if (!second.ok) {
    assert.equal(second.error.length, 200);
    assert.ok(second.error.endsWith("…"));
  }
  assert.equal((await handlers.generate({ prompt: "a fox", model: "m" })).ok, true);
});

test("a refusal that is not an Error still reads as text, and an empty one gets a plain reason", async () => {
  const handlers = createAvatarHandlers(
    deps({
      generate: async () => {
        throw "quota used up";
      },
    }),
  );
  assert.deepEqual(await handlers.generate({ prompt: "a fox", model: "m" }), { ok: false, error: "quota used up", code: "invalid" });
  const blank = createAvatarHandlers(
    deps({
      generate: async () => {
        throw new Error("");
      },
    }),
  );
  assert.deepEqual(await blank.generate({ prompt: "a fox", model: "m" }), { ok: false, error: "The image model did not answer.", code: "invalid" });
});

test("a bug in cutting the picture down is thrown, not reported as a refusal", async () => {
  const handlers = createAvatarHandlers(
    deps({
      shrink: () => {
        throw new (class extends Error {})("plain bug");
      },
    }),
  );
  await assert.rejects(() => handlers.generate({ prompt: "a fox", model: "m" }), /plain bug/);
});

test("a second request while one is running is refused, and the model is asked once", async () => {
  let release: (() => void) | undefined;
  const d = deps({
    generate: (request) =>
      new Promise<RawPicture>((resolve) => {
        d.requests.push(request);
        release = () => resolve(RAW);
      }),
  });
  const handlers = createAvatarHandlers(d);
  const first = handlers.generate({ prompt: "a fox", model: "m" });
  const second = await handlers.generate({ prompt: "a cat", model: "m" });
  assert.deepEqual(second, { ok: false, error: "A picture is already being made. Wait for it to finish.", code: "conflict" });
  assert.equal(d.requests.length, 1);
  release?.();
  assert.equal((await first).ok, true);
  // Done: the next one runs.
  const third = handlers.generate({ prompt: "a dog", model: "m" });
  release?.();
  assert.equal((await third).ok, true);
});

test("a run that ends in a refusal frees the next request too", async () => {
  const handlers = createAvatarHandlers(
    deps({
      shrink: () => {
        throw new Error("boom");
      },
    }),
  );
  await assert.rejects(() => handlers.generate({ prompt: "a fox", model: "m" }));
  await assert.rejects(() => handlers.generate({ prompt: "a fox", model: "m" }), /boom/);
});
