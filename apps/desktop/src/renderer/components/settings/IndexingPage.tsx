import { useCallback, useEffect, useState } from "react";
import { PageHeader, SectionTitle, SettingCard } from "./controls.js";
import type { FileNode } from "../../../shared/types.js";

function countFiles(nodes: FileNode[]): number {
  let n = 0;
  for (const node of nodes) {
    if (node.type === "file") n += 1;
    if (node.children) n += countFiles(node.children);
  }
  return n;
}

interface Props {
  workspaceRoot: string | null;
}

export function IndexingPage({ workspaceRoot }: Props) {
  const [fileCount, setFileCount] = useState<number | null>(null);
  const [indexing, setIndexing] = useState(false);

  const rebuild = useCallback(async () => {
    setIndexing(true);
    try {
      const tree = await window.deyin.files.tree();
      setFileCount(countFiles(tree));
    } finally {
      setIndexing(false);
    }
  }, []);

  useEffect(() => {
    if (workspaceRoot) void rebuild();
  }, [workspaceRoot, rebuild]);

  return (
    <div className="settings-page">
      <PageHeader title="Indexing" description="Deyin indexes your workspace so the agent can search and reference code." />

      <SectionTitle>Workspace index</SectionTitle>
      <SettingCard
        title={workspaceRoot ?? "No workspace open"}
        description={
          workspaceRoot
            ? fileCount === null
              ? "Index not built yet."
              : `${fileCount} files indexed (top levels).`
            : "Open a folder to enable indexing."
        }
      >
        <button className="btn btn--outline" disabled={!workspaceRoot || indexing} onClick={rebuild}>
          {indexing ? "Indexing..." : "Rebuild index"}
        </button>
      </SettingCard>
    </div>
  );
}
