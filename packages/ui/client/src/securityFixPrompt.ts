import type { SecurityFinding } from "@deyin/contract";

/** Formats a prompt to start an agent run fixing a specific security finding. */
export function formatFindingFixPrompt(finding: SecurityFinding): string {
  const fileLoc = finding.location?.file
    ? `${finding.location.file}${finding.location.line ? `:${finding.location.line}` : ""}`
    : null;
  const lines: string[] = [
    `Fix security finding: ${finding.ruleId} (${finding.severity.toUpperCase()})`,
    "",
    `Rule: ${finding.ruleId}`,
    `Severity: ${finding.severity}`,
    `Source: ${finding.source}`,
  ];
  if (fileLoc && finding.location?.file !== "<diff>") {
    lines.push(`Location: ${fileLoc}`);
  }
  lines.push(`Description: ${finding.message}`);
  lines.push("");
  lines.push("Please analyze this issue and apply the necessary fix to resolve the security vulnerability safely.");
  return lines.join("\n");
}

/** Formats a prompt to start an agent run fixing all listed security findings. */
export function formatAllFindingsFixPrompt(findings: SecurityFinding[]): string {
  if (findings.length === 1 && findings[0]) {
    return formatFindingFixPrompt(findings[0]);
  }
  const lines: string[] = [
    `Fix all ${findings.length} security findings:`,
    "",
  ];
  findings.forEach((f, index) => {
    const fileLoc = f.location?.file && f.location.file !== "<diff>"
      ? ` in ${f.location.file}${f.location.line ? `:${f.location.line}` : ""}`
      : "";
    lines.push(`${index + 1}. [${f.severity.toUpperCase()}] ${f.ruleId}${fileLoc}: ${f.message}`);
  });
  lines.push("");
  lines.push("Please inspect each of these security findings and apply the appropriate fixes to resolve them safely.");
  return lines.join("\n");
}
