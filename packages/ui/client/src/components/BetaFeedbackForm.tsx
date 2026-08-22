import { useState } from "react";

interface Props {
  onClose: () => void;
}

/** In-app beta feedback form; submissions append to beta-feedback.jsonl locally. */
export function BetaFeedbackForm({ onClose }: Props) {
  const [category, setCategory] = useState("general");
  const [message, setMessage] = useState("");
  const [rating, setRating] = useState(4);
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!message.trim() || !window.deyin.beta) return;
    setBusy(true);
    try {
      await window.deyin.beta.submitFeedback({ category, message: message.trim(), rating });
      setSent(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="beta-feedback-title">
      <div className="modal beta-feedback-modal">
        <h2 id="beta-feedback-title">Beta feedback</h2>
        {sent ? (
          <>
            <p>Thank you — your feedback was saved locally and queued for telemetry (if enabled).</p>
            <p className="hint">Join the Deyin Discord for live discussion and support.</p>
            <div className="modal__actions">
              <button type="button" className="btn btn--primary" onClick={onClose}>
                Close
              </button>
            </div>
          </>
        ) : (
          <>
            <label className="field">
              Category
              <select className="select" value={category} onChange={(e) => setCategory(e.target.value)}>
                <option value="general">General</option>
                <option value="chat">Chat and streaming</option>
                <option value="tools">Tools and subagents</option>
                <option value="models">Model providers</option>
                <option value="bug">Bug report</option>
              </select>
            </label>
            <label className="field">
              Rating ({rating}/5)
              <input type="range" min={1} max={5} step={1} value={rating} onChange={(e) => setRating(Number(e.target.value))} />
            </label>
            <label className="field">
              Message
              <textarea
                className="textarea"
                rows={5}
                value={message}
                placeholder="What worked well? What broke?"
                onChange={(e) => setMessage(e.target.value)}
              />
            </label>
            <div className="modal__actions">
              <button type="button" className="btn btn--ghost" onClick={onClose}>
                Cancel
              </button>
              <button type="button" className="btn btn--primary" disabled={busy || !message.trim()} onClick={() => void submit()}>
                Submit
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
