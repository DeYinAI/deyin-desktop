import { useMemo } from "react";
import type { CandidateView, DecisionView, ReceiptView, SuperagentView, TicketView } from "@deyin/superagent/client";
import { Icon } from "../Icon.js";
import { EmptyState, FormSection, Row, RowList, Tag } from "../settings/controls.js";
import { needsPerson, ticketLabel, timeAgo } from "./model.js";
import type { SuperagentController } from "./useSuperagent.js";

const openLink = (url: string): void => {
  window.deyin.shell.openExternal(url);
};

function LinkButton({ url, label }: { url: string; label: string }) {
  return (
    <button type="button" className="icon-btn icon-btn--small" title={label} aria-label={label} onClick={() => openLink(url)}>
      <Icon name="external" size={13} />
    </button>
  );
}

function TicketRow({ ticket, now, controller }: { ticket: TicketView; now: number; controller: SuperagentController }) {
  const state = ticketLabel(ticket.state);
  const latest = ticket.assignments[0];
  const summary = [
    `requested by @${ticket.requestedBy}`,
    ticket.prNumber ? `PR #${ticket.prNumber}` : undefined,
    `updated ${timeAgo(ticket.updatedAt, now)}`,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className="superagent__ticket">
      <Row
        title={ticket.title}
        tags={
          <>
            <Tag tone={state.tone}>{state.label}</Tag>
            <Tag tone="muted">{ticket.strength}</Tag>
          </>
        }
        description={summary}
        actions={
          <>
            {ticket.url && <LinkButton url={ticket.url} label="Open on GitHub" />}
            {ticket.canRetry && (
              <button type="button" className="btn btn--ghost btn--small" disabled={controller.busy} onClick={() => void controller.act(() => window.deyin.superagent!.retryTicket(ticket.id))}>
                Retry
              </button>
            )}
            {ticket.canStop && (
              <button type="button" className="btn btn--ghost btn--small" disabled={controller.busy} onClick={() => void controller.act(() => window.deyin.superagent!.stopTicket(ticket.id))}>
                Stop
              </button>
            )}
          </>
        }
      />
      {(ticket.attention || ticket.delivery) && (
        <div className="superagent__note">{ticket.attention ? `Question for a person: ${ticket.attention}` : `The reply could not be posted: ${ticket.delivery}`}</div>
      )}
      <details className="superagent__details">
        <summary>Details</summary>
        <dl className="superagent__facts">
          <dt>Branch</dt>
          <dd className="input-mono">{ticket.branch || "not started"}</dd>
          {ticket.directory && (
            <>
              <dt>Worktree</dt>
              <dd className="input-mono">{ticket.directory}</dd>
            </>
          )}
          {ticket.rules.length > 0 && (
            <>
              <dt>Rules</dt>
              <dd>{ticket.rules.join(", ")}</dd>
            </>
          )}
          {ticket.ended && (
            <>
              <dt>Ended</dt>
              <dd>
                {ticket.ended.reason} ({ticket.ended.by}), {timeAgo(ticket.ended.at, now)}
              </dd>
            </>
          )}
          {latest?.report && (
            <>
              <dt>Last report</dt>
              <dd>
                <strong>{latest.report.state}</strong>: {latest.report.summary}
              </dd>
            </>
          )}
        </dl>
        {ticket.inputs.length > 0 && (
          <ul className="superagent__inputs">
            {ticket.inputs.map((input) => (
              <li key={input.id}>
                <span className="superagent__input-meta">
                  {input.from ? `@${input.from}` : input.kind} · {timeAgo(input.at, now)}
                  {input.delivered ? "" : " · not delivered yet"}
                </span>
                <span>{input.text}</span>
              </li>
            ))}
          </ul>
        )}
      </details>
    </div>
  );
}

function CandidateRow({ candidate, now }: { candidate: CandidateView; now: number }) {
  return (
    <Row
      title={candidate.text || candidate.thread}
      tags={<Tag tone="muted">{candidate.strength}</Tag>}
      description={`@${candidate.from} · ${candidate.thread} · ${candidate.delivered ? "being assessed" : "queued"} since ${timeAgo(candidate.since, now)}`}
      actions={candidate.url ? <LinkButton url={candidate.url} label="Open on GitHub" /> : undefined}
    />
  );
}

function DecisionRow({ decision, now, controller }: { decision: DecisionView; now: number; controller: SuperagentController }) {
  const tone = decision.kind === "accept" ? "ok" : decision.kind === "stop" || decision.kind === "unavailable" ? "warn" : "muted";
  const kind = decision.kind === "ignore" && decision.wouldAccept ? "would accept" : decision.kind;
  return (
    <Row
      title={decision.text || decision.thread}
      tags={<Tag tone={decision.wouldAccept && decision.kind === "ignore" ? "warn" : tone}>{kind}</Tag>}
      description={`${decision.from ? `@${decision.from} · ` : ""}${decision.reason} · ${timeAgo(decision.at, now)}`}
      actions={
        <>
          {decision.url && <LinkButton url={decision.url} label="Open on GitHub" />}
          {decision.kind !== "accept" && decision.triggerId && (
            <button
              type="button"
              className="btn btn--ghost btn--small"
              disabled={controller.busy}
              title="Send this message to assessment again"
              onClick={() => void controller.act(() => window.deyin.superagent!.requeue(decision.triggerId!))}
            >
              Assess again
            </button>
          )}
        </>
      }
    />
  );
}

function ReceiptRow({ receipt, now }: { receipt: ReceiptView; now: number }) {
  const tone = receipt.status === "sent" ? "ok" : receipt.status === "dropped" ? "muted" : receipt.error ? "bad" : "warn";
  return (
    <Row
      title={receipt.text}
      tags={
        <>
          <Tag tone={tone}>{receipt.status}</Tag>
          <Tag tone="muted">{receipt.purpose}</Tag>
        </>
      }
      description={`${receipt.thread} · ${timeAgo(receipt.at, now)}${receipt.error ? ` · ${receipt.error}` : ""}`}
    />
  );
}

/** Tickets first, those that need a person at the top; then what is waiting, what was decided, and what was said. */
export function ActivityTab({ view, controller, now }: { view: SuperagentView; controller: SuperagentController; now: number }) {
  const tickets = useMemo(
    () => [...view.tickets].sort((a, b) => Number(needsPerson(b.state)) - Number(needsPerson(a.state)) || b.updatedAt.localeCompare(a.updatedAt)),
    [view.tickets],
  );
  return (
    <>
      <FormSection title="Tickets" note={tickets.length > 0 ? `${tickets.length}` : undefined}>
        {tickets.length === 0 ? (
          <EmptyState icon="rocket" title="No tickets yet" hint="A ticket is opened when an allowed person asks for a change and the agent accepts it." />
        ) : (
          <div className="superagent__stack">
            {tickets.map((ticket) => (
              <TicketRow key={ticket.id} ticket={ticket} now={now} controller={controller} />
            ))}
          </div>
        )}
      </FormSection>

      {view.candidates.length > 0 && (
        <FormSection title="Waiting for assessment" note={`${view.candidates.length}`}>
          <RowList>
            {view.candidates.map((candidate) => (
              <CandidateRow key={candidate.triggerId} candidate={candidate} now={now} />
            ))}
          </RowList>
        </FormSection>
      )}

      <FormSection title="Recent decisions" note={view.status.mode === "observe" ? "Observing: inferred requests are recorded, not acted on" : undefined}>
        {view.decisions.length === 0 ? (
          <EmptyState title="Nothing decided yet" hint="Messages from allowed accounts on the watched repository show up here once they are assessed." />
        ) : (
          <RowList>
            {view.decisions.map((decision) => (
              <DecisionRow key={decision.id} decision={decision} now={now} controller={controller} />
            ))}
          </RowList>
        )}
      </FormSection>

      {view.receipts.length > 0 && (
        <FormSection title="Replies on GitHub">
          <RowList>
            {view.receipts.map((receipt) => (
              <ReceiptRow key={receipt.id} receipt={receipt} now={now} />
            ))}
          </RowList>
        </FormSection>
      )}
    </>
  );
}
