/**
 * Per-thread composer drafts, as pure logic (no React) so the save/restore
 * semantics on thread switches are unit-testable.
 *
 * The keeper instance is owned by the app root and outlives the composer
 * dock: switching to a view that unmounts the composer (settings, plans,
 * automations) must not drop what the user typed. The dock saves into the
 * keeper on unmount and restores from it on mount.
 */

import type { ContextAttachment, LinkedThreadRef } from "@deyin/contract";
import type { ComposerImage } from "./components/Composer.js";

export interface ComposerDraftState {
  input: string;
  attachments: ContextAttachment[];
  linked: LinkedThreadRef[];
  images: ComposerImage[];
}

export function emptyComposerDraft(): ComposerDraftState {
  return { input: "", attachments: [], linked: [], images: [] };
}

/** Copy a draft so restored state always has fresh array identities. */
function copyDraft(draft: ComposerDraftState): ComposerDraftState {
  return {
    input: draft.input,
    attachments: [...draft.attachments],
    linked: [...draft.linked],
    images: [...draft.images],
  };
}

export class DraftKeeper {
  private readonly drafts = new Map<string, ComposerDraftState>();

  /** The draft saved for a thread (fresh copies), or an empty draft. */
  get(threadId: string | null): ComposerDraftState {
    const draft = threadId ? this.drafts.get(threadId) : undefined;
    return draft ? copyDraft(draft) : emptyComposerDraft();
  }

  /** Save a draft under its thread; a null id (no thread yet) is dropped. */
  save(threadId: string | null, draft: ComposerDraftState): void {
    if (!threadId) return;
    this.drafts.set(threadId, copyDraft(draft));
  }

  /**
   * Thread switch: archive the outgoing draft, hand back the incoming one.
   * The same thread in and out is a no-op restore (fresh copy of the saved
   * draft), matching the previous always-restore-on-switch behavior.
   */
  swap(prevThreadId: string | null, current: ComposerDraftState, nextThreadId: string | null): ComposerDraftState {
    this.save(prevThreadId, current);
    return this.get(nextThreadId);
  }
}
