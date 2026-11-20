import assert from "node:assert/strict";
import { test } from "node:test";
import {
  TEMPLATE_FORMAT,
  TEMPLATE_LIMITS,
  TEMPLATE_LINK_PREFIX,
  TEMPLATE_VERSION,
  botInputFromTemplate,
  isTemplateLink,
  makeBotTemplate,
  parseBotTemplate,
  parseTemplateLink,
  stringifyBotTemplate,
  summarizeTemplate,
  templateLink,
  type BotTemplate,
  type TemplateSource,
} from "../src/bots/template.js";
import { BOT_LIMITS, BotError } from "../src/bots/types.js";

const source = (over: Partial<TemplateSource> = {}): TemplateSource => ({
  name: "Ada",
  title: "Research helper",
  description: "Finds things out.",
  role: "assistant",
  purpose: "Look things up and report back.",
  publicDescription: "Finds things out.",
  avatarShape: "orb",
  avatarColor: "mint",
  skills: [{ name: "lookup", description: "Look something up.", body: "Search, then summarize." }],
  routines: [{ name: "Morning", prompt: "Say good morning.", schedule: { kind: "cron", expression: "0 8 * * *" } }],
  ...over,
});

function refused(text: string, pattern: RegExp): void {
  assert.throws(
    () => parseBotTemplate(text),
    (error: unknown) => {
      assert.ok(error instanceof BotError, `expected a BotError, got ${String(error)}`);
      assert.equal(error.code, "invalid");
      assert.match(error.message, pattern);
      return true;
    },
  );
}

const json = (value: unknown) => JSON.stringify(value);
const valid = () => makeBotTemplate(source());

/* Making ---------------------------------------------------------------------- */

test("a template carries who the Bot is, its skills and its routines, and is marked as one", () => {
  const template = valid();
  assert.equal(template.format, TEMPLATE_FORMAT);
  assert.equal(template.version, TEMPLATE_VERSION);
  assert.deepEqual(
    { name: template.name, skills: template.skills.map((s) => s.name), routines: template.routines.map((r) => r.name) },
    { name: "Ada", skills: ["lookup"], routines: ["Morning"] },
  );
});

test("only a template's own fields are copied, so nothing else a Bot has can travel with it", () => {
  const hostile = {
    ...source(),
    files: ["secret.txt"],
    memory: ["the boss's name"],
    vault: [{ login: "bank" }],
    hostId: "host_1",
    model: "gpt",
    providerId: "mine",
    token: "sk-123456789012345678901234",
    skills: [{ name: "lookup", description: "d", body: "b", apiKey: "sk-leak" }],
    routines: [{ name: "r", prompt: "p", schedule: { kind: "cron", expression: "0 8 * * *", extra: 1 }, botId: "bot_1", model: "gpt", target: { kind: "local" } }],
  } as unknown as TemplateSource;
  const text = stringifyBotTemplate(makeBotTemplate(hostile));
  for (const leaked of ["secret.txt", "boss", "bank", "host_1", "gpt", "mine", "sk-", "apiKey", "bot_1", "target", "extra"]) {
    assert.equal(text.includes(leaked), false, `${leaked} must not be in a template`);
  }
});

test("a routine with no schedule travels as one that is run by hand, and a description only when there is one", () => {
  const template = makeBotTemplate(source({ routines: [{ name: "By hand", prompt: "Do it.", schedule: { kind: "manual" } }] }));
  assert.deepEqual(template.routines, [{ name: "By hand", prompt: "Do it.", schedule: { kind: "manual" } }]);
});

/* Reading ----------------------------------------------------------------------- */

test("a template reads back exactly as it was written", () => {
  const template = valid();
  assert.deepEqual(parseBotTemplate(stringifyBotTemplate(template)), template);
});

test("text that is not a template is refused with words a person can act on", () => {
  refused("", /no template there/);
  refused("   ", /no template there/);
  refused("hello", /not a Bot template/);
  refused("{ broken", /not a Bot template/);
  refused("[]", /not in a form/);
  refused("null", /not in a form/);
  refused(json({ name: "Ada" }), /not a Bot template/);
  refused(json({ format: "something-else", version: 1, name: "Ada" }), /not a Bot template/);
});

test("a version is required, and one from a newer Deyin says to update rather than guessing", () => {
  const base = { format: TEMPLATE_FORMAT, name: "Ada" };
  refused(json(base), /no version/);
  refused(json({ ...base, version: "1" }), /no version/);
  refused(json({ ...base, version: 0 }), /no version/);
  refused(json({ ...base, version: 1.5 }), /no version/);
  refused(json({ ...base, version: TEMPLATE_VERSION + 1 }), /newer version of Deyin/);
});

test("a template may arrive in a code block, as people paste it, or as a link", () => {
  const text = stringifyBotTemplate(valid());
  assert.equal(parseBotTemplate("```json\n" + text + "\n```").name, "Ada");
  assert.equal(parseBotTemplate("```\n" + text + "\n```").name, "Ada");
  assert.equal(parseBotTemplate(`  \n${text}\n  `).name, "Ada");
  const link = templateLink(valid());
  assert.ok(link);
  assert.equal(parseBotTemplate(link).name, "Ada");
});

test("what the Bot is called is required and held to the same limit as any Bot's name", () => {
  const base = valid();
  refused(json({ ...base, name: "" }), /name is missing/);
  refused(json({ ...base, name: "   " }), /name is missing/);
  refused(json({ ...base, name: 7 }), /name is missing/);
  refused(json({ ...base, name: "x".repeat(BOT_LIMITS.name + 1) }), new RegExp(`longer than ${BOT_LIMITS.name} characters`));
  assert.equal(parseBotTemplate(json({ ...base, name: "x".repeat(BOT_LIMITS.name) })).name.length, BOT_LIMITS.name);
});

test("every other field is held to its limit too, and missing optional ones become empty", () => {
  const base = valid();
  refused(json({ ...base, title: "x".repeat(BOT_LIMITS.title + 1) }), /title is longer/);
  refused(json({ ...base, description: "x".repeat(BOT_LIMITS.description + 1) }), /description is longer/);
  refused(json({ ...base, role: "x".repeat(BOT_LIMITS.role + 1) }), /role is longer/);
  refused(json({ ...base, purpose: "x".repeat(BOT_LIMITS.purpose + 1) }), /What the Bot is for is longer/);
  refused(json({ ...base, publicDescription: "x".repeat(BOT_LIMITS.publicDescription + 1) }), /public description is longer/);
  const bare = parseBotTemplate(json({ format: TEMPLATE_FORMAT, version: 1, name: "Ada" }));
  assert.deepEqual(bare, { format: TEMPLATE_FORMAT, version: 1, name: "Ada", title: "", description: "", role: "", purpose: "", publicDescription: "", skills: [], routines: [] });
});

test("fields that are not part of a template are dropped, wherever they are", () => {
  const dirty = {
    ...valid(),
    files: ["a"],
    vault: [1],
    hostId: "host_1",
    skills: [{ name: "lookup", description: "d", body: "b", secret: "s" }],
    routines: [{ name: "r", prompt: "p", schedule: { kind: "cron", expression: "0 8 * * *", z: 1 }, model: "gpt", botId: "x" }],
  };
  const parsed = parseBotTemplate(json(dirty));
  assert.equal(JSON.stringify(parsed).includes("host_1"), false);
  assert.equal(JSON.stringify(parsed).includes("gpt"), false);
  assert.equal(JSON.stringify(parsed).includes("secret"), false);
  assert.deepEqual(Object.keys(parsed).sort(), ["avatarColor", "avatarShape", "description", "format", "name", "publicDescription", "purpose", "role", "routines", "skills", "title", "version"]);
});

test("an avatar the app does not have is dropped rather than refused, so the Bot gets its own default", () => {
  const parsed = parseBotTemplate(json({ ...valid(), avatarShape: "star", avatarColor: "#ff0000" }));
  assert.equal("avatarShape" in parsed, false);
  assert.equal("avatarColor" in parsed, false);
  assert.equal(botInputFromTemplate(parsed).avatarShape, undefined);
});

test("control characters and extra whitespace are cleaned from what is read", () => {
  const parsed = parseBotTemplate(json({ ...valid(), name: "Ada\u0007\n  Lovelace", purpose: "Line one\r\nLine two\u0000" }));
  assert.equal(parsed.name, "Ada Lovelace");
  assert.equal(parsed.purpose, "Line one\nLine two");
});

/* Skills and routines inside ---------------------------------------------------- */

test("a skill in a template is checked as strictly as one a person types, and a twin is refused", () => {
  const base = valid();
  refused(json({ ...base, skills: "lookup" }), /skills are not in a form/);
  refused(json({ ...base, skills: [{ name: "Bad Name", description: "d", body: "b" }] }), /lowercase letters and numbers/);
  refused(json({ ...base, skills: [{ name: "a", description: "", body: "b" }] }), /Say in a sentence/);
  refused(json({ ...base, skills: [{ name: "a", description: "d", body: "" }] }), /needs instructions/);
  refused(json({ ...base, skills: [{ name: "a", description: "d", body: "b" }, { name: "a", description: "e", body: "c" }] }), /"a" is in the template twice/);
  const many = Array.from({ length: TEMPLATE_LIMITS.skills + 1 }, (_, n) => ({ name: `s${n}`, description: "d", body: "b" }));
  refused(json({ ...base, skills: many }), new RegExp(`at most ${TEMPLATE_LIMITS.skills} skills`));
  assert.equal(parseBotTemplate(json({ ...base, skills: many.slice(0, TEMPLATE_LIMITS.skills) })).skills.length, TEMPLATE_LIMITS.skills);
});

test("a routine in a template needs a name and something to do, and a schedule that is a real one", () => {
  const base = valid();
  const withRoutine = (routine: unknown) => json({ ...base, routines: [routine] });
  refused(json({ ...base, routines: "daily" }), /routines are not in a form/);
  refused(withRoutine("daily"), /Routine 1 is not in a form/);
  refused(withRoutine({ prompt: "p" }), /name of routine 1 is missing/);
  refused(withRoutine({ name: "n" }), /What "n" does is missing/);
  refused(withRoutine({ name: "x".repeat(TEMPLATE_LIMITS.routineName + 1), prompt: "p" }), /longer than 60/);
  refused(withRoutine({ name: "n", prompt: "x".repeat(TEMPLATE_LIMITS.routinePrompt + 1) }), /longer than 4,000/);
  refused(withRoutine({ name: "n", prompt: "p", description: "x".repeat(TEMPLATE_LIMITS.routineDescription + 1) }), /description of "n" is longer/);
  refused(withRoutine({ name: "n", prompt: "p", schedule: { kind: "once", at: 1 } }), /schedule this app does not know/);
  refused(withRoutine({ name: "n", prompt: "p", schedule: "daily" }), /schedule of "n" is not in a form/);
  refused(withRoutine({ name: "n", prompt: "p", schedule: { kind: "cron" } }), /schedule of "n" is missing/);
  refused(withRoutine({ name: "n", prompt: "p", schedule: { kind: "cron", expression: "every day" } }), /not a cron expression/);
  refused(withRoutine({ name: "n", prompt: "p", schedule: { kind: "cron", expression: "0 8 * *" } }), /not a cron expression/);
  refused(withRoutine({ name: "n", prompt: "p", schedule: { kind: "cron", expression: "0 8 * * * * *" } }), /not a cron expression/);
  refused(withRoutine({ name: "n", prompt: "p", schedule: { kind: "cron", expression: `* ${"1 ".repeat(100)}` } }), /longer than 120/);
  const many = Array.from({ length: TEMPLATE_LIMITS.routines + 1 }, (_, n) => ({ name: `r${n}`, prompt: "p" }));
  refused(json({ ...base, routines: many }), new RegExp(`at most ${TEMPLATE_LIMITS.routines} routines`));
});

test("a routine without a schedule is read as one run by hand; 5 and 6 field schedules are both fine", () => {
  const parsed = parseBotTemplate(
    json({
      ...valid(),
      routines: [
        { name: "a", prompt: "p" },
        { name: "b", prompt: "p", schedule: null },
        { name: "c", prompt: "p", schedule: { kind: "manual" } },
        { name: "d", prompt: "p", schedule: { kind: "cron", expression: "0 8 * * 1-5" } },
        { name: "e", prompt: "p", schedule: { kind: "cron", expression: "0 0 8 * * 1-5" } },
      ],
    }),
  );
  assert.deepEqual(parsed.routines.map((r) => r.schedule.kind), ["manual", "manual", "manual", "cron", "cron"]);
});

/* Size ----------------------------------------------------------------------------- */

test("something too large to be a template is refused before it is parsed", () => {
  refused("x".repeat(TEMPLATE_LIMITS.chars * 2 + 1), /too large/);
  refused(`{"pad":"${"x".repeat(TEMPLATE_LIMITS.chars)}"}`, /too large/);
});

/* What becomes of it --------------------------------------------------------------- */

test("the Bot a template makes has its identity and purpose but no say over where it runs or what it may do", () => {
  const input = botInputFromTemplate(parseBotTemplate(stringifyBotTemplate(valid())));
  assert.deepEqual(input, { name: "Ada", description: "Finds things out.", title: "Research helper", role: "assistant", purpose: "Look things up and report back.", publicDescription: "Finds things out.", avatarShape: "orb", avatarColor: "mint" });
  for (const absent of ["harness", "hostId", "approvalMode", "visibility", "kind", "memberBotIds", "routinePolicy", "legacyBotId"]) assert.equal(absent in input, false, absent);
  assert.equal("role" in botInputFromTemplate({ ...valid(), role: "" }), false, "an empty role leaves the default alone");
});

test("a summary names the skills and which routines run by themselves, for the person to read before agreeing", () => {
  const summary = summarizeTemplate(valid());
  assert.deepEqual(summary, {
    name: "Ada",
    title: "Research helper",
    description: "Finds things out.",
    skills: [{ name: "lookup", description: "Look something up." }],
    routines: [{ name: "Morning", scheduled: true }],
  });
  assert.equal(summarizeTemplate(makeBotTemplate(source({ routines: [{ name: "x", prompt: "p", schedule: { kind: "manual" } }] }))).routines[0]!.scheduled, false);
});

/* Links ----------------------------------------------------------------------------- */

test("a short template becomes a link that opens Deyin, and the link carries the whole template, accents and all", () => {
  const template = makeBotTemplate(source({ name: "Zoë 日本", purpose: "Parle français — 100% «précis»." }));
  const link = templateLink(template);
  assert.ok(link?.startsWith(TEMPLATE_LINK_PREFIX));
  assert.match(link!, /^deyin:\/\/bot\/import\?t=[A-Za-z0-9_-]+$/, "nothing that needs escaping in a link");
  assert.deepEqual(parseBotTemplate(link!), template);
});

test("a template too long for a link has none, and says so by being null", () => {
  const long: BotTemplate = makeBotTemplate(source({ purpose: "p".repeat(BOT_LIMITS.purpose), skills: Array.from({ length: 6 }, (_, n) => ({ name: `s${n}`, description: "d", body: "b".repeat(3_000) })) }));
  assert.equal(templateLink(long), null);
  assert.ok(templateLink(valid()));
});

test("only a Deyin import link is read as one, and a damaged one gives nothing instead of throwing", () => {
  const link = templateLink(valid())!;
  assert.ok(parseTemplateLink(link));
  assert.ok(parseTemplateLink(`  ${link}  `));
  for (const not of [
    "https://example.com/bot/import?t=abc",
    "deyin://oauth/callback?code=1",
    "deyin://bot/export?t=abc",
    "deyin://bot/import",
    "deyin://bot/import?x=1",
    "deyin://bot/import?t=!!!",
    "deyin://bot/import?t=_w",
    "deyin://other/import?t=e30",
    "",
    "hello",
  ]) {
    assert.equal(parseTemplateLink(not), null, not);
  }
  refused("deyin://bot/import?t=e30", /not a Bot template/);
});

test("the app can tell an import link from a sign-in link before reading it", () => {
  assert.equal(isTemplateLink("deyin://bot/import?t=abc"), true);
  assert.equal(isTemplateLink("DEYIN://bot/import"), true);
  assert.equal(isTemplateLink("deyin://bot/import/"), true);
  assert.equal(isTemplateLink("  deyin://bot/import#x "), true);
  assert.equal(isTemplateLink("deyin://oauth/callback?code=1"), false);
  assert.equal(isTemplateLink("deyin://bot/importer"), false);
  assert.equal(isTemplateLink("deyin://bot/other"), false);
});
