import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

export interface ProjectToolchainInfo {
  primaryLanguage: string;
  packageManager?: string;
  isMonorepo: boolean;
  virtualEnv?: string;
  commands: {
    test?: string;
    build?: string;
    typecheck?: string;
    lint?: string;
    dev?: string;
  };
  availableScripts?: Record<string, string>;
  detectedFiles: string[];
}

async function readJsonSafe<T = Record<string, unknown>>(path: string): Promise<T | null> {
  try {
    const content = await readFile(path, "utf8");
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

/**
 * Introspects workspace root to detect language, toolchains, package managers,
 * and standard lifecycle commands (test, build, typecheck, lint).
 */
export async function detectProjectToolchain(cwd: string): Promise<ProjectToolchainInfo | null> {
  let rootFiles: string[] = [];
  try {
    const entries = await readdir(cwd, { withFileTypes: true });
    rootFiles = entries.map((e) => e.name);
  } catch {
    return null;
  }

  const fileSet = new Set(rootFiles);
  const detectedFiles: string[] = [];
  const commands: ProjectToolchainInfo["commands"] = {};
  let pm: string | undefined;
  let lang = "generic";
  let isMonorepo = false;
  let virtualEnv: string | undefined;
  let availableScripts: Record<string, string> | undefined;

  for (const vName of [".venv", "venv", "env", ".env"]) {
    if (fileSet.has(vName)) {
      virtualEnv = vName;
      detectedFiles.push(vName);
      break;
    }
  }

  // 1. Rust detection
  if (fileSet.has("Cargo.toml")) {
    detectedFiles.push("Cargo.toml");
    lang = "rust";
    pm = "cargo";
    commands.test = "cargo test";
    commands.build = "cargo build";
    commands.typecheck = "cargo check";
    commands.lint = "cargo clippy";
    if (fileSet.has("Cargo.lock")) detectedFiles.push("Cargo.lock");
  }

  // 2. Go detection
  else if (fileSet.has("go.mod")) {
    detectedFiles.push("go.mod");
    lang = "go";
    pm = "go";
    commands.test = "go test ./...";
    commands.build = "go build ./...";
    commands.typecheck = "go vet ./...";
    commands.lint = "golangci-lint run";
  }

  // 3. Node.js / TypeScript / JavaScript detection
  else if (fileSet.has("package.json")) {
    detectedFiles.push("package.json");
    const isTs = fileSet.has("tsconfig.json") || fileSet.has("tsconfig.base.json");
    if (isTs) detectedFiles.push("tsconfig.json");
    lang = isTs ? "typescript" : "javascript";

    if (fileSet.has("pnpm-lock.yaml")) {
      pm = "pnpm";
      detectedFiles.push("pnpm-lock.yaml");
    } else if (fileSet.has("bun.lockb") || fileSet.has("bun.lock")) {
      pm = "bun";
      detectedFiles.push(fileSet.has("bun.lockb") ? "bun.lockb" : "bun.lock");
    } else if (fileSet.has("yarn.lock")) {
      pm = "yarn";
      detectedFiles.push("yarn.lock");
    } else if (fileSet.has("package-lock.json")) {
      pm = "npm";
      detectedFiles.push("package-lock.json");
    } else {
      pm = "npm";
    }

    if (fileSet.has("pnpm-workspace.yaml") || fileSet.has("lerna.json") || fileSet.has("turbo.json") || fileSet.has("nx.json")) {
      isMonorepo = true;
      if (fileSet.has("pnpm-workspace.yaml")) detectedFiles.push("pnpm-workspace.yaml");
      if (fileSet.has("turbo.json")) detectedFiles.push("turbo.json");
    }

    interface PkgJson {
      scripts?: Record<string, string>;
      workspaces?: unknown;
    }
    const pkg = await readJsonSafe<PkgJson>(join(cwd, "package.json"));
    if (pkg?.workspaces) isMonorepo = true;

    if (pkg?.scripts) {
      availableScripts = pkg.scripts;
      const s = pkg.scripts;
      const run = pm === "npm" ? "npm run" : pm;

      if (s.test) {
        commands.test = `${pm} test`;
      } else if (s["test:unit"]) {
        commands.test = `${run} test:unit`;
      }

      if (s.build) commands.build = `${run} build`;

      if (s.typecheck) {
        commands.typecheck = `${run} typecheck`;
      } else if (s["check:types"] || s.check) {
        commands.typecheck = `${run} ${s.typecheck ? "typecheck" : s["check:types"] ? "check:types" : "check"}`;
      } else if (isTs) {
        commands.typecheck = "npx tsc --noEmit";
      }

      if (s.lint) {
        commands.lint = `${run} lint`;
      }

      if (s.dev) commands.dev = `${run} dev`;
      else if (s.start) commands.dev = `${run} start`;
    } else if (isTs) {
      commands.typecheck = "npx tsc --noEmit";
    }
  }

  // 4. Python detection
  else if (fileSet.has("pyproject.toml") || fileSet.has("requirements.txt") || fileSet.has("Pipfile") || fileSet.has("poetry.lock") || fileSet.has("uv.lock")) {
    lang = "python";
    if (fileSet.has("uv.lock")) {
      pm = "uv";
      detectedFiles.push("uv.lock");
      commands.test = "uv run pytest";
      commands.typecheck = "uv run mypy .";
      commands.lint = "uv run ruff check";
    } else if (fileSet.has("poetry.lock")) {
      pm = "poetry";
      detectedFiles.push("poetry.lock");
      commands.test = "poetry run pytest";
      commands.typecheck = "poetry run mypy .";
      commands.lint = "poetry run flake8";
    } else if (fileSet.has("Pipfile")) {
      pm = "pipenv";
      detectedFiles.push("Pipfile");
      commands.test = "pipenv run pytest";
    } else {
      pm = "pip";
      if (fileSet.has("requirements.txt")) detectedFiles.push("requirements.txt");
      if (fileSet.has("pyproject.toml")) detectedFiles.push("pyproject.toml");
      commands.test = "pytest";
      commands.typecheck = "mypy .";
      commands.lint = "ruff check";
    }
  }

  // 5. Java / Kotlin detection
  else if (fileSet.has("pom.xml")) {
    detectedFiles.push("pom.xml");
    lang = "java";
    pm = "maven";
    commands.test = "mvn test";
    commands.build = "mvn compile";
    commands.typecheck = "mvn compile";
  } else if (fileSet.has("build.gradle") || fileSet.has("build.gradle.kts")) {
    const gradleFile = fileSet.has("build.gradle.kts") ? "build.gradle.kts" : "build.gradle";
    detectedFiles.push(gradleFile);
    lang = "java";
    pm = "gradle";
    const gradlew = fileSet.has("gradlew") ? "./gradlew" : "gradle";
    commands.test = `${gradlew} test`;
    commands.build = `${gradlew} build`;
  }

  // 6. Ruby detection
  else if (fileSet.has("Gemfile")) {
    detectedFiles.push("Gemfile");
    lang = "ruby";
    pm = "bundler";
    commands.test = "bundle exec rspec";
    commands.lint = "bundle exec rubocop";
  }

  // 7. PHP detection
  else if (fileSet.has("composer.json")) {
    detectedFiles.push("composer.json");
    lang = "php";
    pm = "composer";
    commands.test = "composer test";
    commands.lint = "composer check";
  }

  // 8. C / C++ detection
  else if (fileSet.has("CMakeLists.txt")) {
    detectedFiles.push("CMakeLists.txt");
    lang = "cpp";
    pm = "cmake";
    commands.build = "cmake --build build";
    commands.test = "ctest --test-dir build";
  } else if (fileSet.has("Makefile")) {
    detectedFiles.push("Makefile");
    lang = "c";
    pm = "make";
    commands.build = "make";
    commands.test = "make test";
  }

  // 9. Fallback if Python virtual environment exists
  else if (virtualEnv) {
    lang = "python";
    pm = "pip";
    commands.test = "pytest";
    commands.typecheck = "mypy .";
    commands.lint = "ruff check";
  }

  if (detectedFiles.length === 0) {
    return null;
  }

  return {
    primaryLanguage: lang,
    packageManager: pm,
    isMonorepo,
    virtualEnv,
    commands,
    availableScripts,
    detectedFiles,
  };
}

/**
 * Formats detected project toolchain information for injection into the system prompt.
 */
export function formatProjectToolchainPrompt(info: ProjectToolchainInfo | null): string | null {
  if (!info) return null;

  const lines: string[] = ["# Project Toolchain & Commands"];
  const monorepoSuffix = info.isMonorepo ? " (monorepo)" : "";
  lines.push(`- Language: ${info.primaryLanguage}${monorepoSuffix}`);
  if (info.packageManager) {
    lines.push(`- Package Manager: ${info.packageManager} (detected via ${info.detectedFiles.join(", ")})`);
  }
  if (info.virtualEnv) {
    lines.push(`- Python Virtual Environment: \`${info.virtualEnv}\` (binaries automatically active in PATH)`);
  }

  if (info.commands.test) lines.push(`- Test Command: \`${info.commands.test}\``);
  if (info.commands.build) lines.push(`- Build Command: \`${info.commands.build}\``);
  if (info.commands.typecheck) lines.push(`- Typecheck Command: \`${info.commands.typecheck}\``);
  if (info.commands.lint) lines.push(`- Lint Command: \`${info.commands.lint}\``);
  if (info.commands.dev) lines.push(`- Dev/Start Command: \`${info.commands.dev}\``);

  if (info.availableScripts) {
    const scriptKeys = Object.keys(info.availableScripts);
    if (scriptKeys.length > 0) {
      lines.push(`- Manifest Scripts: ${scriptKeys.slice(0, 15).join(", ")}${scriptKeys.length > 15 ? ` (+${scriptKeys.length - 15} more)` : ""}`);
    }
  }

  lines.push(
    "- When verifying changes, prefer using the detected commands directly rather than guessing or probing directory contents.",
  );

  return lines.join("\n");
}
