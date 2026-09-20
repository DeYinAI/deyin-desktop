import type { BenchmarkSuite } from "./types.js";

/**
 * Built-in smoke benchmark suite for quick verification and smoke testing.
 * Runs basic coding, debugging, and data processing tasks.
 */
export const BUILTIN_BENCHMARK_SUITE: BenchmarkSuite = {
  name: "Deyin Built-in Coding Benchmark",
  description: "Standard reproducible coding tasks covering file creation, bug fixing, and structured data handling.",
  tasks: [
    {
      id: "create-math-add",
      name: "Create Math Add Function",
      description: "Create a module with an add(a, b) export.",
      prompt: "Create a file named math.js that exports a function named add(a, b) which returns the sum of a and b using CommonJS (module.exports = { add }).",
      verify: {
        filesExist: ["math.js"],
        command: "node -e \"const { add } = require('./math.js'); if (add(2, 3) !== 5) process.exit(1);\"",
      },
      timeoutSeconds: 60,
      maxSteps: 8,
    },
    {
      id: "fix-calculator-bug",
      name: "Fix Calculator Multiply Bug",
      description: "Fix a multiply implementation that accidentally adds instead of multiplying.",
      prompt: "In calculator.js, the multiply function is broken and returns addition. Fix it so it correctly multiplies a and b.",
      setup: {
        files: {
          "calculator.js": "function multiply(a, b) {\n  return a + b;\n}\nmodule.exports = { multiply };\n",
        },
      },
      verify: {
        filesExist: ["calculator.js"],
        filesContain: {
          "calculator.js": "return\\s+a\\s*\\*\\s*b",
        },
        command: "node -e \"const { multiply } = require('./calculator.js'); if (multiply(4, 5) !== 20) process.exit(1);\"",
      },
      timeoutSeconds: 60,
      maxSteps: 8,
    },
    {
      id: "transform-json-summary",
      name: "Generate JSON Summary",
      description: "Read an input data file and generate a transformed summary JSON.",
      prompt: "Read input.json, count the total number of items in the 'items' array, and write a summary.json file containing { \"count\": <total>, \"status\": \"ready\" }.",
      setup: {
        files: {
          "input.json": "{\n  \"items\": [\"apple\", \"banana\", \"cherry\", \"date\"]\n}\n",
        },
      },
      verify: {
        filesExist: ["summary.json"],
        command: "node -e \"const s = require('./summary.json'); if (s.count !== 4 || s.status !== 'ready') process.exit(1);\"",
      },
      timeoutSeconds: 60,
      maxSteps: 8,
    },
  ],
};
