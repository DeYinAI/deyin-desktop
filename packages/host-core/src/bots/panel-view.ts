import type { BotSkillInput } from "./skills.js";
import type { CatalogCategory } from "./catalog.js";
import type { DeyinBot } from "./types.js";
import type { TemplateSummary } from "./template.js";

/**
 * What the Skills, Files, Marketplace and Teach panels send and are sent. Plain data, safe to show: nothing secret and
 * nothing a person has not been shown travels in it.
 */

/** A Bot handed over as text, with the link that carries it when it is short enough. */
export interface ExportedTemplate {
  text: string;
  link: string | null;
  summary: TemplateSummary;
  /** Things that were left out or could not travel, in words. */
  warnings: string[];
}

export interface TemplatePreview {
  summary: TemplateSummary;
}

/** What a person chose for the routines an imported Bot comes with: they run on the model they pick, and start paused. */
export interface ImportOptions {
  model: string;
  providerId: string;
}

export interface ImportedBot {
  bot: DeyinBot;
  skills: number;
  routines: number;
  warnings: string[];
}

/** A starter as the marketplace lists it. The template itself stays in the main process until it is imported. */
export interface CatalogCard {
  id: string;
  name: string;
  title: string;
  blurb: string;
  category: CatalogCategory;
  tags: readonly string[];
  skills: number;
  routines: number;
  /** One made from it already exists. */
  have: boolean;
  /** The name of the example it was adapted from, when it is one. */
  derivedFrom?: string;
}

export interface CatalogListing {
  forYou: CatalogCard[];
  browse: CatalogCard[];
}

/** The two places a person keeps files for their Bots: a Bot's own folder, and the library every Bot can read. */
export const FILE_SCOPES = ["bot", "library"] as const;
export type FileScope = (typeof FILE_SCOPES)[number];

export type CopyDirection = "to-bot" | "to-library";

export interface FileContent {
  path: string;
  content: string;
  /** Size in bytes. */
  size: number;
}

/** What a person sees while they teach: that it is recording, for whom, and how much has been kept. */
export interface TeachState {
  recording: boolean;
  botId?: string;
  title?: string;
  steps: number;
  /** Nothing more will be kept: the most steps or the longest time was reached. */
  full: boolean;
  secretsOmitted: number;
  /** The newest step, as a sentence. */
  last?: string;
}

/** A skill drafted from a recording, for the person to read and change before it is saved. */
export interface TeachDraft {
  skill: BotSkillInput;
  warnings: string[];
  steps: number;
}
