/**
 * Composer dock: owns everything about the draft being composed — the text,
 * attachments, linked threads, and images — so a keystroke re-renders this
 * component instead of the entire app root (the previous behavior cost a full
 * 3,000-line render per character).
 *
 * Everything that must outlive this component lives in the parent: drafts are
 * archived per thread in a `DraftKeeper` owned by the app root (survives view
 * switches that unmount the composer), and sending is delegated upward via
 * `onSend(text, draft)` / `onSendNow(text, fromInput)` so the app keeps its
 * routing logic. Clearing after a send comes back down through an imperative
 * handle, which lets the app keep the draft on failure paths (signed out,
 * missing API key) exactly as before.
 */

import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState, type ReactNode } from "react";
import { Composer } from "./Composer.js";
import { ComposerPendingBars } from "./ComposerPendingBars.js";
import { type ComposerDraftState, type DraftKeeper } from "../composer-draft.js";
import type { ComposerProps } from "./Composer.js";

/** What the app can ask the dock to clear after (or during) a send. */
export interface ComposerHandle {
  clearInput(): void;
  clearImages(): void;
  /** Clear the whole draft: text, attachments, linked threads, images. */
  clearComposerState(): void;
}

type DockedComposerProps = Omit<
  ComposerProps,
  | "value"
  | "onChange"
  | "canSend"
  | "onSend"
  | "onSendNow"
  | "attachments"
  | "onAttachmentsChange"
  | "images"
  | "onImagesChange"
  | "linkedThreads"
  | "onLinkedThreadsChange"
>;

export interface ComposerDockProps extends DockedComposerProps {
  /** Active thread; a change swaps the draft (save old, restore new). */
  threadId: string | null;
  /** App-owned draft store; outlives this component across view switches. */
  keeper: DraftKeeper;
  /** Chat-only hosts hide the pending bars, workspace bar, and attachments. */
  chatOnly: boolean;
  /** Show the live draft as a steer bar (a run is streaming in this thread). */
  steerActive: boolean;
  /** Follow-up queued while a run is active (drained by send-now). */
  queued: string | null;
  onSend: (text: string, draft: ComposerDraftState) => void | Promise<void>;
  onSendNow: (text: string, fromInput: boolean) => void;
  onStartMultitasking?: () => void;
  onClearQueue?: () => void;
  /** Rendered between the pending bars and the composer (the workspace bar). */
  children?: ReactNode;
}

export const ComposerDock = forwardRef<ComposerHandle, ComposerDockProps>(function ComposerDock(props, ref) {
  const {
    threadId,
    keeper,
    chatOnly,
    steerActive,
    queued,
    onSend,
    onSendNow,
    onStartMultitasking,
    onClearQueue,
    children,
    ...composerProps
  } = props;
  const initialDraft = useMemo(() => keeper.get(threadId), [keeper]); // eslint-disable-line react-hooks/exhaustive-deps
  const [input, setInput] = useState(initialDraft.input);
  const [attachments, setAttachments] = useState(initialDraft.attachments);
  const [linked, setLinked] = useState(initialDraft.linked);
  const [images, setImages] = useState(initialDraft.images);

  // Mirror of the full draft, readable from effects and cleanup without deps.
  const draftRef = useRef<ComposerDraftState>(initialDraft);
  draftRef.current = { input, attachments, linked, images };
  const threadIdRef = useRef(threadId);

  useEffect(() => {
    const prev = threadIdRef.current;
    threadIdRef.current = threadId;
    if (prev === threadId) return;
    const restored = keeper.swap(prev, draftRef.current, threadId);
    setInput(restored.input);
    setAttachments(restored.attachments);
    setLinked(restored.linked);
    setImages(restored.images);
  }, [threadId, keeper]);

  // Unmount (view switch): archive the draft so remounting restores it.
  useEffect(() => {
    return () => keeper.save(threadIdRef.current, draftRef.current);
  }, [keeper]);

  useImperativeHandle(
    ref,
    () => ({
      clearInput: () => setInput(""),
      clearImages: () => setImages([]),
      clearComposerState: () => {
        setInput("");
        setAttachments([]);
        setLinked([]);
        setImages([]);
      },
    }),
    [],
  );

  const currentDraft = (): ComposerDraftState => ({ input, attachments, linked, images });
  const handleSend = () => {
    void onSend(input.trim(), currentDraft());
  };
  const handleSendNow = () => {
    const fromInput = input.trim();
    const text = fromInput || queued?.trim() || "";
    if (!text) return;
    onSendNow(text, fromInput.length > 0);
  };

  return (
    <>
      {!chatOnly && (
        <>
          <ComposerPendingBars
            queued={queued}
            steer={steerActive ? input : null}
            onSendNow={handleSendNow}
            onStartMultitasking={onStartMultitasking}
            onClearQueue={onClearQueue}
            onSteer={handleSend}
            onDismissSteer={() => setInput("")}
          />
          {children}
        </>
      )}
      <Composer
        {...composerProps}
        value={input}
        onChange={setInput}
        canSend={input.trim().length > 0}
        onSend={handleSend}
        onSendNow={chatOnly ? undefined : handleSendNow}
        attachments={chatOnly ? [] : attachments}
        onAttachmentsChange={chatOnly ? undefined : setAttachments}
        images={chatOnly ? [] : images}
        onImagesChange={chatOnly ? undefined : setImages}
        linkedThreads={chatOnly ? [] : linked}
        onLinkedThreadsChange={chatOnly ? undefined : setLinked}
      />
    </>
  );
});
