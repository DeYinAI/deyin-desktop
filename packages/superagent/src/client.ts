/**
 * What a UI needs to show and edit Superagent state. It reaches the browser, so everything it imports at run time must be
 * free of Node modules; `test/client-entry.test.ts` holds it to that.
 */
export { ADMISSION_DEFAULTS, ADMISSION_OPTIONS, GITHUB_ROWS, LIMITS as SETTINGS_LIMITS, defaultSettings } from "./settings.js";
export type { Allowed, GithubRow, ModelRef, Rule, Settings } from "./settings.js";
export type { TicketCardState } from "./agents/cards.js";
export type {
  AssignmentView,
  CandidateView,
  DecisionView,
  InputView,
  ReceiptView,
  SuperagentStatus,
  SuperagentView,
  TicketView,
} from "./view.js";
