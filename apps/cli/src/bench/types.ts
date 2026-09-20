export interface BenchmarkTaskSetup {
  /** Relative file paths and their initial string content */
  files?: Record<string, string>;
  /** Shell command to run in the workspace before the agent runs */
  command?: string;
}

export interface BenchmarkTaskVerify {
  /** Shell command(s) that must exit with code 0 */
  command?: string | string[];
  /** Relative file paths that must exist after run */
  filesExist?: string[];
  /** Relative file paths and substrings/regex that must be present in their contents */
  filesContain?: Record<string, string | string[]>;
}

export interface BenchmarkTask {
  id: string;
  name?: string;
  description?: string;
  prompt: string;
  setup?: BenchmarkTaskSetup;
  verify?: BenchmarkTaskVerify;
  timeoutSeconds?: number;
  maxSteps?: number;
}

export interface BenchmarkSuite {
  name: string;
  description?: string;
  tasks: BenchmarkTask[];
}

export type BenchmarkTaskStatus = "passed" | "failed" | "timeout" | "error";

export interface TaskBenchmarkResult {
  id: string;
  name?: string;
  status: BenchmarkTaskStatus;
  durationMs: number;
  steps: number;
  tokens: {
    prompt: number;
    completion: number;
    cached: number;
    total: number;
  };
  finishReason?: string;
  error?: string;
  verificationOutput?: string;
  workspaceDir?: string;
}

export interface BenchmarkSuiteResult {
  suiteName: string;
  description?: string;
  timestamp: string;
  model: string;
  provider: string;
  totalDurationMs: number;
  summary: {
    total: number;
    passed: number;
    failed: number;
    timeouts: number;
    errors: number;
    passRate: number; // 0.0 to 1.0
    totalTokens: {
      prompt: number;
      completion: number;
      cached: number;
      total: number;
    };
  };
  tasks: TaskBenchmarkResult[];
}

export interface BenchmarkRunOptions {
  suite?: BenchmarkSuite;
  suitePath?: string;
  filter?: string;
  maxSteps?: number;
  timeoutSeconds?: number;
  keepWorkspaces?: boolean;
  verbose?: boolean;
  signal?: AbortSignal;
  onTaskStart?: (task: BenchmarkTask, index: number, total: number) => void;
  onTaskDone?: (task: BenchmarkTask, result: TaskBenchmarkResult, index: number, total: number) => void;
  getToken?: () => Promise<string | null>;
}
