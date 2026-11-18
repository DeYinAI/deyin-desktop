/**
 * Goal-loop constants shared by the browser-safe command parser and the
 * node-side reviewer.
 *
 * This module deliberately imports nothing: the renderer bundle pulls it in
 * through `@deyin/agent-core/goal-command`, so a single dependency back into the
 * streaming stack would drag node-only modules into the browser build.
 */

/** Max objective length accepted by `/goal`. */
export const MAX_GOAL_OBJECTIVE = 4000;

/** Default ceiling on how many continuation rounds one goal may spend. */
export const DEFAULT_MAX_GOAL_ROUNDS = 25;
