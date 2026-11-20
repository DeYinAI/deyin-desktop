import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { FILE_SCOPES, type DeyinBot, type FileScope, type RuntimeFileEntry } from "@deyin/host-core/shared";
import { useT } from "../i18n.js";
import { fill } from "../automationFormat.js";
import { useConfirm } from "../components/ConfirmDialog.js";
import { attempt } from "./botCalls.js";
import {
  FILE_NAME_MAX,
  copyDirection,
  copyLabelKey,
  crumbs,
  fileContentProblem,
  formatSize,
  isFileDirty,
  joinPath,
  newFileProblem,
  sortEntries,
  type FileEditor,
  type FilesApi,
} from "./botFiles.js";

export type FilesState =
  | { status: "loading" }
  | { status: "error"; error: string }
  | { status: "ready"; entries: RuntimeFileEntry[] };

const SCOPE_LABEL = { bot: "bot.files.scope.bot", library: "bot.files.scope.library" } as const;

interface BotFilesPanelProps {
  scope: FileScope;
  /** The folder being looked at; "" for the top. */
  dir: string;
  state: FilesState;
  notice: string | null;
  info: string | null;
  editor: FileEditor | null;
  /** What a new file is called, while one is being made. */
  newName: string | null;
  onScope: (scope: FileScope) => void;
  onOpenDir: (path: string) => void;
  onOpenFile: (path: string) => void;
  onNewFile: () => void;
  onNewName: (name: string) => void;
  onContent: (content: string) => void;
  onSave: () => void;
  onCancel: () => void;
  onRemove: (entry: RuntimeFileEntry) => void;
  onCopy: (entry: RuntimeFileEntry) => void;
}

/** The files section as pure markup, so every state can be rendered without a host. */
export function BotFilesPanel(props: BotFilesPanelProps) {
  const { scope, dir, state, editor, newName } = props;
  const t = useT();
  const taken = state.status === "ready" ? state.entries.map((entry) => entry.name) : [];
  const newProblem = newName !== null ? newFileProblem(newName, taken) : null;
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    props.onSave();
  };
  const problem = editor ? fileContentProblem(editor.content) : null;
  return (
    <section className="bot-panel" aria-label={t("bot.files.title")}>
      <h3 className="bot-detail__heading">{t("bot.files.title")}</h3>
      <p className="hint">{t("bot.files.hint")}</p>
      <div className="bot-panel__tabs" role="tablist" aria-label={t("bot.files.title")}>
        {FILE_SCOPES.map((one) => (
          <button key={one} type="button" role="tab" aria-selected={scope === one} className={`btn ${scope === one ? "btn--outline" : "btn--ghost"}`} onClick={() => props.onScope(one)}>
            {t(SCOPE_LABEL[one])}
          </button>
        ))}
      </div>
      <p className="hint">{t(scope === "bot" ? "bot.files.scope.botHint" : "bot.files.scope.libraryHint")}</p>
      <nav className="bot-panel__crumbs" aria-label={t("bot.files.location")}>
        <button type="button" className="btn btn--ghost" onClick={() => props.onOpenDir("")} disabled={dir === ""}>
          {t(SCOPE_LABEL[scope])}
        </button>
        {crumbs(dir).map((crumb) => (
          <span key={crumb.path}>
            <span aria-hidden="true"> / </span>
            <button type="button" className="btn btn--ghost" onClick={() => props.onOpenDir(crumb.path)} disabled={crumb.path === dir}>
              {crumb.name}
            </button>
          </span>
        ))}
      </nav>
      {props.notice ? (
        <p className="hint--bad" role="alert">
          {props.notice}
        </p>
      ) : null}
      {props.info ? (
        <p className="hint" role="status">
          {props.info}
        </p>
      ) : null}
      {state.status === "loading" ? (
        <p className="hint" role="status">
          {t("bot.files.loading")}
        </p>
      ) : null}
      {state.status === "error" ? (
        <p className="hint--bad" role="alert">
          {t("bot.files.loadError")} {state.error}
        </p>
      ) : null}
      {state.status === "ready" && state.entries.length === 0 ? <p className="hint">{t("bot.files.empty")}</p> : null}
      {state.status === "ready" && state.entries.length > 0 ? (
        <ul className="bot-panel__list">
          {sortEntries(state.entries).map((entry) => (
            <li key={entry.path} className="bot-panel__item">
              <div className="bot-panel__main">
                <strong className="bot-panel__name">{entry.kind === "directory" ? `${entry.name}/` : entry.name}</strong>
                {entry.kind === "file" ? <span className="bot-panel__meta">{formatSize(entry.size)}</span> : null}
              </div>
              <div className="bot-panel__actions">
                {entry.kind === "directory" ? (
                  <button type="button" className="btn btn--ghost" onClick={() => props.onOpenDir(entry.path)}>
                    {t("bot.files.open")}
                  </button>
                ) : (
                  <>
                    <button type="button" className="btn btn--ghost" onClick={() => props.onOpenFile(entry.path)}>
                      {t("bot.files.edit")}
                    </button>
                    <button type="button" className="btn btn--ghost" onClick={() => props.onCopy(entry)}>
                      {t(copyLabelKey(scope))}
                    </button>
                  </>
                )}
                <button type="button" className="btn btn--ghost btn--danger" onClick={() => props.onRemove(entry)}>
                  {t("bot.files.remove")}
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      {state.status === "ready" && !editor && newName === null ? (
        <button type="button" className="btn btn--outline" onClick={props.onNewFile}>
          {t("bot.files.new")}
        </button>
      ) : null}
      {editor ? (
        <form className="bot-panel__editor" onSubmit={submit} aria-label={editor.isNew ? t("bot.files.new") : fill(t("bot.files.editing"), { path: editor.path })}>
          {editor.isNew ? (
            <div className="field">
              <label className="field__label" htmlFor="file-name">
                {t("bot.files.name")}
              </label>
              <input id="file-name" className="input" value={newName ?? ""} maxLength={FILE_NAME_MAX} disabled={editor.busy} autoComplete="off" placeholder={t("bot.files.namePlaceholder")} onChange={(event) => props.onNewName(event.target.value)} />
            </div>
          ) : (
            <p className="hint">{editor.path}</p>
          )}
          <div className="field">
            <label className="field__label" htmlFor="file-content">
              {t("bot.files.content")}
            </label>
            <textarea id="file-content" className="input bot-panel__code" rows={12} value={editor.content} disabled={editor.busy} onChange={(event) => props.onContent(event.target.value)} />
          </div>
          {editor.error ? (
            <p className="hint--bad" role="alert">
              {editor.error}
            </p>
          ) : problem ? (
            <p className="hint--bad" role="status">
              {t(problem)}
            </p>
          ) : editor.isNew && newName && newProblem ? (
            <p className="hint--bad" role="status">
              {t(newProblem)}
            </p>
          ) : null}
          <div className="bot-panel__buttons">
            <button type="button" className="btn btn--outline" disabled={editor.busy} onClick={props.onCancel}>
              {t("bot.files.cancel")}
            </button>
            <button type="submit" className="btn btn--primary" disabled={editor.busy || problem !== null || !isFileDirty(editor) || (editor.isNew && newProblem !== null)}>
              {t(editor.busy ? "bot.files.saving" : "bot.files.save")}
            </button>
          </div>
        </form>
      ) : null}
    </section>
  );
}

interface BotFilesProps {
  bot: DeyinBot;
  api: FilesApi;
}

/** A Bot's own files, and the library every Bot can read. */
export function BotFiles({ bot, api }: BotFilesProps) {
  const t = useT();
  const { confirm } = useConfirm();
  const [scope, setScope] = useState<FileScope>("bot");
  const [dir, setDir] = useState("");
  const [entries, setEntries] = useState<RuntimeFileEntry[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [editor, setEditor] = useState<FileEditor | null>(null);
  const [newName, setNewName] = useState<string | null>(null);
  const mounted = useRef(true);
  /** Counts listings asked for, so a slow answer about another folder cannot replace the one being looked at. */
  const loads = useRef(0);
  const owner = scope === "bot" ? bot.id : null;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(async (): Promise<void> => {
    loads.current += 1;
    const mine = loads.current;
    const outcome = await attempt(() => api.list(scope, owner, dir));
    if (!mounted.current || mine !== loads.current) return;
    if (outcome.ok) {
      setEntries(outcome.value);
      setLoadError(null);
    } else {
      setLoadError(outcome.error);
    }
  }, [api, scope, owner, dir]);

  // Another Bot's page starts at the top of its own folder.
  useEffect(() => {
    setScope("bot");
    setDir("");
    setEditor(null);
    setNewName(null);
    setNotice(null);
    setInfo(null);
  }, [bot.id]);

  useEffect(() => {
    setEntries(null);
    setLoadError(null);
    void load();
    return api.onChange((event) => {
      if (event.scope === scope && event.botId === owner) void load();
    });
  }, [api, scope, owner, load]);

  const state: FilesState = loadError ? { status: "error", error: loadError } : entries === null ? { status: "loading" } : { status: "ready", entries };

  const reset = (): void => {
    setEditor(null);
    setNewName(null);
    setNotice(null);
    setInfo(null);
  };

  const openFile = async (path: string): Promise<void> => {
    setNotice(null);
    setInfo(null);
    const outcome = await attempt(() => api.read(scope, owner, path));
    if (!mounted.current) return;
    if (outcome.ok) {
      setNewName(null);
      setEditor({ path: outcome.value.path, isNew: false, original: outcome.value.content, content: outcome.value.content, busy: false, error: null });
    } else {
      setNotice(outcome.error);
    }
  };

  const save = async (): Promise<void> => {
    if (!editor || editor.busy) return;
    const path = editor.isNew ? joinPath(dir, (newName ?? "").trim()) : editor.path;
    if (editor.isNew && newFileProblem(newName ?? "", entries?.map((entry) => entry.name) ?? []) !== null) return;
    if (fileContentProblem(editor.content) !== null) return;
    setEditor({ ...editor, busy: true, error: null });
    const outcome = await attempt(() => api.write(scope, owner, path, editor.content));
    if (!mounted.current) return;
    if (outcome.ok) {
      setEditor(null);
      setNewName(null);
      void load();
    } else {
      setEditor((current) => (current ? { ...current, busy: false, error: outcome.error } : current));
    }
  };

  const remove = async (entry: RuntimeFileEntry): Promise<void> => {
    const accepted = await confirm({
      title: entry.name,
      message: t(entry.kind === "directory" ? "bot.files.removeFolderMessage" : "bot.files.removeMessage"),
      confirmLabel: t("bot.files.remove"),
      destructive: true,
    });
    if (!accepted) return;
    const outcome = await attempt(() => api.remove(scope, owner, entry.path));
    if (!mounted.current) return;
    if (!outcome.ok) {
      setNotice(outcome.error);
      return;
    }
    setNotice(null);
    setInfo(null);
    setEditor((current) => (current && (current.path === entry.path || current.path.startsWith(`${entry.path}/`)) ? null : current));
    void load();
  };

  const copy = async (entry: RuntimeFileEntry): Promise<void> => {
    setNotice(null);
    setInfo(null);
    const outcome = await attempt(() => api.copy(copyDirection(scope), bot.id, entry.path));
    if (!mounted.current) return;
    if (outcome.ok) setInfo(fill(t(scope === "bot" ? "bot.files.copiedToLibrary" : "bot.files.copiedToBot"), { path: outcome.value.path }));
    else setNotice(outcome.error);
  };

  return (
    <BotFilesPanel
      scope={scope}
      dir={dir}
      state={state}
      notice={notice}
      info={info}
      editor={editor}
      newName={newName}
      onScope={(next) => {
        reset();
        setScope(next);
        setDir("");
      }}
      onOpenDir={(path) => {
        reset();
        setDir(path);
      }}
      onOpenFile={(path) => void openFile(path)}
      onNewFile={() => {
        setNotice(null);
        setInfo(null);
        setNewName("");
        setEditor({ path: dir, isNew: true, original: "", content: "", busy: false, error: null });
      }}
      onNewName={(name) => setNewName(name)}
      onContent={(content) => setEditor((current) => (current ? { ...current, error: null, content } : current))}
      onSave={() => void save()}
      onCancel={() => {
        setEditor(null);
        setNewName(null);
      }}
      onRemove={(entry) => void remove(entry)}
      onCopy={(entry) => void copy(entry)}
    />
  );
}
