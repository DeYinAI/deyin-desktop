import { CH } from "@deyin/contract";
import type { BotRuntime, BotStore, DeyinBot } from "@deyin/host-core";
import { PendingImport } from "../deep-link.js";
import { createFilesHandlers } from "./files-handlers.js";
import { BotSkillStores, createBotSkillsHandlers } from "./skills-handlers.js";
import { TeachCapture } from "./teach-capture.js";
import { activeTeachTarget, type TeachWebContents } from "./teach-electron.js";
import { createTeachHandlers } from "./teach-handlers.js";
import { createTemplateHandlers, type TemplateRoutines } from "./template-handlers.js";

export interface BotSurfaceDeps {
  store: Pick<BotStore, "get" | "list" | "create" | "delete" | "dataDir">;
  /** The routines a Bot has, and a way to make one; imported Bots bring theirs through it. */
  routines: TemplateRoutines;
  /** The computer a Bot works on: this one, or its server. */
  runtimeOf(bot: DeyinBot): BotRuntime;
  /** The folder every Bot can read, on this computer. */
  library: BotRuntime;
  /** The in-app browser tab the person is in, or null when none is open. */
  browserTab(): TeachWebContents | null;
  /** Answer a call from a window. Arguments arrive untrusted, so every handler checks its own. */
  handle(channel: string, handler: (...args: unknown[]) => unknown): void;
  /** Tell every window. */
  broadcast(channel: string, payload: unknown): void;
  /** A Bot's skills changed: bring whatever keeps a copy of them (its routines on a server) up to date. */
  skillsChanged(botId: string): void;
}

export interface BotSurface {
  /** The one skill store per Bot, for whatever else in the app needs to change a Bot's skills. */
  stores: BotSkillStores;
  /** A shared Bot's link arrived: tell the window, and keep it until the window has taken it. */
  offerImport(link: string): void;
  /** Keep the stores of the Bots still in the roster. */
  retain(botIds: Iterable<string>): void;
  /** Stop what is running: a recording is thrown away. */
  dispose(): Promise<void>;
}

/**
 * Everything the Skills, Marketplace, Files and Teach panels call, registered in one place. The handlers do the work and
 * check what they are given; this only connects them to the windows.
 */
export function registerBotSurface(deps: BotSurfaceDeps): BotSurface {
  const { handle, broadcast } = deps;
  const stores = new BotSkillStores(deps.store);
  const pending = new PendingImport();

  const skillsChanged = (botId: string): void => {
    broadcast(CH.botSkillsChanged, botId);
    deps.skillsChanged(botId);
  };
  const skills = createBotSkillsHandlers({ stores, changed: skillsChanged });
  handle(CH.botSkillsList, (botId) => skills.list(botId));
  handle(CH.botSkillsGet, (botId, name) => skills.get(botId, name));
  handle(CH.botSkillsSave, (botId, input, expectedVersion) => skills.save(botId, input, expectedVersion));
  handle(CH.botSkillsRemove, (botId, name) => skills.remove(botId, name));
  handle(CH.botSkillsRevisions, (botId, name) => skills.revisions(botId, name));
  handle(CH.botSkillsRevert, (botId, name, revisionId) => skills.revert(botId, name, revisionId));

  const templates = createTemplateHandlers({ store: deps.store, stores, routines: deps.routines });
  handle(CH.botTemplatesExport, (botId, options) => templates.export(botId, options));
  handle(CH.botTemplatesPreview, (text) => templates.preview(text));
  handle(CH.botTemplatesImport, (text, options) => templates.import(text, options));
  handle(CH.botTemplatesCatalog, (query, category) => templates.catalog(query, category));
  handle(CH.botTemplatesImportCatalog, (id, options) => templates.importCatalog(id, options));
  handle(CH.botTemplatesTakeLink, () => pending.take());

  const files = createFilesHandlers({
    store: deps.store,
    runtimeOf: deps.runtimeOf,
    library: deps.library,
    changed: (scope, botId) => broadcast(CH.botFilesChanged, { scope, botId }),
  });
  handle(CH.botFilesList, (scope, botId, path) => files.list(scope, botId, path));
  handle(CH.botFilesRead, (scope, botId, path) => files.read(scope, botId, path));
  handle(CH.botFilesWrite, (scope, botId, path, content) => files.write(scope, botId, path, content));
  handle(CH.botFilesRemove, (scope, botId, path) => files.remove(scope, botId, path));
  handle(CH.botFilesCopy, (direction, botId, path, as) => files.copy(direction, botId, path, as));

  const teach = createTeachHandlers({
    store: deps.store,
    stores,
    capture: (onEvent) => new TeachCapture({ active: activeTeachTarget(deps.browserTab), onEvent }),
    onChange: (state) => broadcast(CH.botTeachChanged, state),
    saved: skillsChanged,
  });
  handle(CH.botTeachState, () => teach.state());
  handle(CH.botTeachStart, (botId, title) => teach.start(botId, title));
  handle(CH.botTeachNote, (text) => teach.note(text));
  handle(CH.botTeachStop, (options) => teach.stop(options));
  handle(CH.botTeachCancel, () => teach.cancel());
  handle(CH.botTeachSave, (botId, skill) => teach.save(botId, skill));

  return {
    stores,
    offerImport: (link) => {
      pending.offer(link);
      broadcast(CH.botTemplatesLink, link);
    },
    retain: (botIds) => stores.retain(botIds),
    dispose: async () => {
      await teach.cancel();
    },
  };
}
