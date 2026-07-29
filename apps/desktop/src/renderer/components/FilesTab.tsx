import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isPathInsideRoot } from "@deyin/host-core/shared";
import type { FileNode } from "../../shared/types.js";
import { CodeBlock, themeByName } from "../code.js";
import type { CodeDisplaySettings } from "./panelTypes.js";
import { Icon } from "./Icon.js";

const BINARY_EXT = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".pdf",
  ".zip",
  ".gz",
  ".tar",
  ".wasm",
  ".mp4",
  ".mp3",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".bin",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
]);

const LANG_BY_EXT: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".json": "json",
  ".md": "markdown",
  ".mdc": "markdown",
  ".css": "css",
  ".scss": "scss",
  ".html": "html",
  ".xml": "xml",
  ".svg": "xml",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "toml",
  ".py": "python",
  ".rs": "rust",
  ".go": "go",
  ".java": "java",
  ".kt": "kotlin",
  ".rb": "ruby",
  ".php": "php",
  ".sh": "shell",
  ".bash": "shell",
  ".zsh": "shell",
  ".sql": "sql",
  ".graphql": "graphql",
  ".vue": "vue",
  ".svelte": "svelte",
};

const DRAFT_BANNER = "Unsaved draft from previous workspace — copy text; Save unavailable.";

interface FilesTabProps {
  platform: "desktop" | "web";
  /** True when the Files tab is the visible panel tab (gates Ctrl+S). */
  active: boolean;
  workspaceRoot: string | null;
  codeDisplay: CodeDisplaySettings;
  onOpenFolder?: () => void;
}

function extOf(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot >= 0 ? path.slice(dot).toLowerCase() : "";
}

function langFromPath(path: string): string | undefined {
  return LANG_BY_EXT[extOf(path)];
}

function isBinaryPath(path: string): boolean {
  return BINARY_EXT.has(extOf(path));
}

function graftChildren(nodes: FileNode[], dirPath: string, children: FileNode[]): FileNode[] {
  return nodes.map((node) => {
    if (node.path === dirPath && node.type === "directory") {
      return { ...node, children };
    }
    if (node.type === "directory" && node.children) {
      return { ...node, children: graftChildren(node.children, dirPath, children) };
    }
    return node;
  });
}

export function FilesTab(props: FilesTabProps) {
  const [tree, setTree] = useState<FileNode[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [loadingDirs, setLoadingDirs] = useState<Set<string>>(() => new Set());
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [editing, setEditing] = useState(false);
  const [draftMode, setDraftMode] = useState(false);
  const [loadingFile, setLoadingFile] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [treeLoading, setTreeLoading] = useState(false);
  /**
   * Non-blocking discard-unsaved-changes prompt. `window.confirm` blocks the
   * Electron renderer main thread (and traps backgrounded windows); we keep a
   * pending-action descriptor and resolve it from a modal instead.
   */
  const [pendingDiscard, setPendingDiscard] = useState<
    | { message: string; onConfirm: () => void; onCancel: () => void }
    | null
  >(null);
  const openGenRef = useRef(0);
  const treeGenRef = useRef(0);
  const expandGenRef = useRef(new Map<string, number>());
  const dirtyRef = useRef(false);
  const selectedPathRef = useRef<string | null>(null);
  const refreshTreeRef = useRef<() => Promise<void>>(async () => undefined);

  const dirty = content !== savedContent;
  dirtyRef.current = dirty;
  selectedPathRef.current = selectedPath;
  const selectedName = selectedPath ? selectedPath.split(/[\\/]/).pop() ?? selectedPath : null;
  const variant = props.codeDisplay.variant ?? "dark";
  const codeTheme = themeByName(
    variant === "light" ? (props.codeDisplay.themeLight ?? "GitHub Light") : (props.codeDisplay.themeDark ?? "GitHub Dark"),
    variant,
  );

  const enterDraftMode = useCallback(() => {
    openGenRef.current += 1;
    setSelectedPath(null);
    setSavedContent("");
    setEditing(true);
    setDraftMode(true);
    setError(DRAFT_BANNER);
    setLoadingFile(false);
  }, []);

  const clearEditor = useCallback(() => {
    openGenRef.current += 1;
    setSelectedPath(null);
    setContent("");
    setSavedContent("");
    setEditing(false);
    setDraftMode(false);
    setError(null);
    setLoadingFile(false);
  }, []);

  const refreshTree = useCallback(async () => {
    if (!props.workspaceRoot) {
      setTree([]);
      return;
    }
    const gen = ++treeGenRef.current;
    expandGenRef.current.clear();
    setTreeLoading(true);
    setError((cur) => (cur === DRAFT_BANNER ? cur : null));
    try {
      const nodes = await window.deyin.files.tree();
      if (gen !== treeGenRef.current) return;
      setTree(nodes);
      // Collapse on refresh — root itself is not a tree row, so seeding it does nothing useful.
      setExpanded(new Set());
    } catch (err) {
      if (gen !== treeGenRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (gen === treeGenRef.current) setTreeLoading(false);
    }
  }, [props.workspaceRoot]);

  refreshTreeRef.current = refreshTree;

  const prevRootRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const prev = prevRootRef.current;
    prevRootRef.current = props.workspaceRoot;

    const rootChanged = prev !== undefined && prev !== props.workspaceRoot;
    const root = props.workspaceRoot;
    // Real project/sandbox switch (not disconnect ↔ reconnect null flashes).
    const stableSwitch = rootChanged && prev != null && root != null;

    if (stableSwitch && dirtyRef.current) {
      const name = selectedPathRef.current?.split(/[\\/]/).pop() ?? "file";
      setPendingDiscard({
        message: `Workspace changed. Discard unsaved changes${name ? ` to ${name}` : ""}?`,
        onConfirm: () => {
          setPendingDiscard(null);
          clearEditor();
          treeGenRef.current += 1;
          expandGenRef.current.clear();
          void refreshTreeRef.current();
        },
        onCancel: () => {
          setPendingDiscard(null);
          enterDraftMode();
          treeGenRef.current += 1;
          expandGenRef.current.clear();
          void refreshTreeRef.current();
        },
      });
      return;
    }

    if (rootChanged || prev === undefined) {
      if (stableSwitch) {
        clearEditor();
      } else if (rootChanged && root == null) {
        // Disconnect / ensure failure: keep dirty buffer in draft mode without a dialog.
        if (dirtyRef.current) {
          enterDraftMode();
        } else {
          clearEditor();
        }
      } else if (rootChanged && prev == null && root) {
        // Root restored after null: draft if dirty path is outside the new sandbox.
        if (dirtyRef.current && selectedPathRef.current && !isPathInsideRoot(root, selectedPathRef.current)) {
          enterDraftMode();
        } else if (!dirtyRef.current) {
          clearEditor();
        }
      } else if (prev === undefined) {
        clearEditor();
      }
      treeGenRef.current += 1;
      expandGenRef.current.clear();
    }
    void refreshTreeRef.current();
  }, [props.workspaceRoot, clearEditor, enterDraftMode]);

  const toggleDir = useCallback(
    async (node: FileNode) => {
      if (node.type !== "directory") return;
      const isOpen = expanded.has(node.path);
      if (isOpen) {
        setExpanded((cur) => {
          const next = new Set(cur);
          next.delete(node.path);
          return next;
        });
        return;
      }

      setExpanded((cur) => new Set(cur).add(node.path));
      if (node.children !== undefined) return;

      const treeGen = treeGenRef.current;
      const token = (expandGenRef.current.get(node.path) ?? 0) + 1;
      expandGenRef.current.set(node.path, token);

      setLoadingDirs((cur) => new Set(cur).add(node.path));
      setError((cur) => (cur === DRAFT_BANNER ? cur : null));
      try {
        const children = await window.deyin.files.tree(node.path);
        if (treeGen !== treeGenRef.current) return;
        if (expandGenRef.current.get(node.path) !== token) return;
        setTree((cur) => graftChildren(cur, node.path, children));
      } catch (err) {
        if (treeGen !== treeGenRef.current) return;
        if (expandGenRef.current.get(node.path) !== token) return;
        setError(err instanceof Error ? err.message : String(err));
        setExpanded((cur) => {
          const next = new Set(cur);
          next.delete(node.path);
          return next;
        });
      } finally {
        if (treeGen === treeGenRef.current && expandGenRef.current.get(node.path) === token) {
          setLoadingDirs((cur) => {
            const next = new Set(cur);
            next.delete(node.path);
            return next;
          });
        }
      }
    },
    [expanded],
  );

  const openFileInternal = useCallback(async (path: string) => {
    const gen = ++openGenRef.current;
    setDraftMode(false);

    if (isBinaryPath(path)) {
      if (gen !== openGenRef.current) return;
      setSelectedPath(path);
      setContent("");
      setSavedContent("");
      setEditing(false);
      setError(null);
      setLoadingFile(false);
      return;
    }

    setSelectedPath(path);
    setLoadingFile(true);
    setError(null);
    setEditing(false);
    try {
      const text = await window.deyin.files.read(path);
      if (gen !== openGenRef.current) return;
      setContent(text);
      setSavedContent(text);
    } catch (err) {
      if (gen !== openGenRef.current) return;
      setContent("");
      setSavedContent("");
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (gen === openGenRef.current) setLoadingFile(false);
    }
  }, []);

  const openFile = useCallback(
    async (path: string) => {
      if (path === selectedPath && !draftMode) return;
      if (dirtyRef.current) {
        setPendingDiscard({
          message: "Discard unsaved changes?",
          onConfirm: () => {
            setPendingDiscard(null);
            void openFileInternal(path);
          },
          onCancel: () => setPendingDiscard(null),
        });
        return;
      }
      await openFileInternal(path);
    },
    [selectedPath, draftMode, openFileInternal],
  );

  const saveFile = useCallback(async () => {
    if (!selectedPath || isBinaryPath(selectedPath) || draftMode) return;
    setSaving(true);
    setError(null);
    try {
      await window.deyin.files.write(selectedPath, content);
      setSavedContent(content);
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [selectedPath, content, draftMode]);

  useEffect(() => {
    if (!props.active || draftMode) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "s") return;
      if (!editing || !dirty || saving) return;
      e.preventDefault();
      void saveFile();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [props.active, draftMode, editing, dirty, saving, saveFile]);

  const treeRows = useMemo(() => {
    const rows: JSX.Element[] = [];
    const walk = (nodes: FileNode[], depth: number) => {
      for (const node of nodes) {
        const isDir = node.type === "directory";
        const isOpen = expanded.has(node.path);
        const isSelected = selectedPath === node.path;
        const isLoading = loadingDirs.has(node.path);
        rows.push(
          <button
            key={node.path}
            className={`files-tree__row ${isSelected ? "files-tree__row--selected" : ""}`}
            style={{ paddingLeft: `${8 + depth * 14}px` }}
            onClick={() => {
              if (isDir) void toggleDir(node);
              else void openFile(node.path);
            }}
            title={node.path}
          >
            {isDir ? (
              <Icon name={isOpen ? "chevronDown" : "chevronRight"} size={11} />
            ) : (
              <span className="files-tree__spacer" />
            )}
            <Icon name={isDir ? "folder" : "file"} size={12} />
            <span className="files-tree__name">{node.name}</span>
            {isLoading && <span className="files-tree__loading">…</span>}
          </button>,
        );
        if (isDir && isOpen && node.children) walk(node.children, depth + 1);
      }
    };
    walk(tree, 0);
    return rows;
  }, [tree, expanded, loadingDirs, selectedPath, toggleDir, openFile]);

  if (!props.workspaceRoot && !dirty && !draftMode) {
    return (
      <div className="wspanel__body wspanel__empty files-tab__empty">
        <p>No workspace open.</p>
        {props.platform === "desktop" && props.onOpenFolder && (
          <button className="chip" onClick={props.onOpenFolder}>
            Open folder
          </button>
        )}
      </div>
    );
  }

  const showDraftEditor = draftMode && editing;
  const canEditSelected = Boolean(selectedPath && !isBinaryPath(selectedPath));
  const rootLabel =
    props.workspaceRoot?.split(/[\\/]/).filter(Boolean).pop() ?? (draftMode ? "Disconnected" : "Workspace");

  return (
    <>
      <div className="wspanel__subbar">
        <Icon name="folder" size={13} />
        <span className="crumb crumb--file files-tab__root" title={props.workspaceRoot ?? undefined}>
          {rootLabel}
        </span>
        <div className="wspanel__subbar-spacer" />
        <button className="chip chip--small" onClick={() => void refreshTree()} disabled={treeLoading} title="Refresh">
          <Icon name="refresh" size={12} />
        </button>
        {draftMode ? (
          <button
            className="chip chip--small"
            onClick={() => {
              clearEditor();
            }}
          >
            Discard draft
          </button>
        ) : canEditSelected ? (
          <>
            {!editing ? (
              <button className="chip chip--small" onClick={() => setEditing(true)} disabled={loadingFile}>
                Edit
              </button>
            ) : (
              <>
                <button className="chip chip--small" onClick={() => { setContent(savedContent); setEditing(false); }} disabled={saving}>
                  Cancel
                </button>
                <button
                  className={`chip chip--small ${dirty ? "chip--active" : ""}`}
                  onClick={() => void saveFile()}
                  disabled={!dirty || saving}
                >
                  {saving ? "Saving…" : "Save"}
                </button>
              </>
            )}
          </>
        ) : null}
        {dirty && <span className="wstab__dot" title="Unsaved changes" />}
      </div>

      <div className="files-tab">
        <div className="files-tab__tree">
          {treeLoading && tree.length === 0 ? (
            <div className="wspanel__empty">Loading…</div>
          ) : tree.length === 0 ? (
            <div className="wspanel__empty">No files found.</div>
          ) : (
            treeRows
          )}
        </div>

        <div className="files-tab__viewer">
          {showDraftEditor ? (
            <textarea
              className="files-tab__editor"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              spellCheck={false}
              style={{ fontSize: props.codeDisplay.codeFontSize }}
            />
          ) : !selectedPath ? (
            <div className="wspanel__empty">Select a file to view or edit.</div>
          ) : isBinaryPath(selectedPath) ? (
            <div className="wspanel__empty">Binary file — preview not available.</div>
          ) : loadingFile ? (
            <div className="wspanel__empty">Loading…</div>
          ) : editing ? (
            <textarea
              className="files-tab__editor"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              spellCheck={false}
              style={{ fontSize: props.codeDisplay.codeFontSize }}
            />
          ) : (
            <div className="files-tab__code">
              <CodeBlock
                code={content}
                theme={codeTheme}
                fontSize={props.codeDisplay.codeFontSize}
                showLineNumbers={props.codeDisplay.showLineNumbers}
                wrapLongLines={props.codeDisplay.wrapLongLines}
                lang={langFromPath(selectedPath)}
              />
            </div>
          )}
          {error && <div className="files-tab__error">{error}</div>}
          {selectedName && (
            <div className="files-tab__footer" title={selectedPath ?? undefined}>
              {selectedName}
            </div>
          )}
          {draftMode && !selectedName && (
            <div className="files-tab__footer">Unsaved draft</div>
          )}
        </div>
      </div>

      {pendingDiscard && (
        <div className="approval" role="dialog" aria-modal="true">
          <div className="approval__box">
            <div className="approval__title">
              <Icon name="shield" size={15} />
              Discard unsaved changes?
            </div>
            <div className="approval__summary">{pendingDiscard.message}</div>
            <div className="approval__actions">
              <button
                className="btn btn--outline"
                onClick={pendingDiscard.onCancel}
                autoFocus
              >
                Keep changes
              </button>
              <button className="btn" onClick={pendingDiscard.onConfirm}>
                Discard
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
