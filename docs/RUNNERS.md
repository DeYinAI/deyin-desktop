# Self-hosted runners

CI verify, PR AI review, and release packaging run on **self-hosted Linux** machines
(GitHub-hosted runners are disabled due to Actions budget limits).

## Current fleet

| Runner | OS | Labels | Workloads |
|--------|-----|--------|-----------|
| **dell-runner** | Linux | `self-hosted`, `Linux`, `X64` | CI verify, AI review, Linux + Windows release builds |
| **mac-runner** | macOS | `self-hosted`, `macOS`, `release-mac` | macOS DMG release builds (requires a Mac — cannot cross-compile from Linux) |
| **win-runner** | Windows | `self-hosted`, `X64`, `Windows` | Deprecated — not used by workflows |

**Bottleneck:** one Linux runner serves every workflow. Add more machines with the same labels to parallelize.

## Quick add (works immediately)

Any new Linux runner uses the **same labels** as dell-runner. GitHub distributes jobs across all idle runners with matching labels.

### 1. Prepare the host

For **CI-only** capacity (verify + AI review), Node 22 + pnpm + git is enough.

For **release** jobs too (Linux + Windows installers on dell-runner; macOS DMG on mac-runner), install the full toolchain:

```bash
git clone git@github.com:DeYinAI/deyin-desktop.git
cd deyin-desktop
sudo bash scripts/ci/setup-dell-runner.sh   # Linux host (Wine, .NET, Bun)
bash scripts/ci/check-dell-runner.sh
```

**macOS DMG builds** require a separate Mac with `bash scripts/ci/setup-mac-runner.sh` and
`RUNNER_NAME=mac-runner bash scripts/ci/register-mac-runner.sh`. electron-builder cannot
produce macOS installers from the Linux dell-runner.

### 2. Register

Token: **GitHub → DeYinAI/deyin-desktop → Settings → Actions → Runners → New self-hosted runner**.

```bash
export RUNNER_TOKEN="..."   # one-time token from GitHub UI

# Example: this WSL box, a second NUC, or a cloud VM
RUNNER_NAME=wsl-ci-1 bash scripts/ci/register-linux-runner.sh
```

Repo admins:

```bash
export RUNNER_TOKEN="$(gh api repos/DeYinAI/deyin-desktop/actions/runners/registration-token --jq .token)"
RUNNER_NAME=wsl-ci-1 bash scripts/ci/register-linux-runner.sh
```

### 3. Confirm

**Settings → Actions → Runners** — runner shows **Idle**. Re-run a queued workflow or push to `main`.

---

## Optional: CI vs release label split

Once you have two or more machines, split workloads so lightweight hosts don't pick up Wine/NSIS release builds:

| Label | Workflows | Toolchain |
|-------|-----------|-----------|
| **`ci`** | `ci.yml`, `pr-ai-review.yml` | Node, pnpm, git |
| **`release`** | `release.yml` | Above + Wine, .NET 8, Bun |

**Migration order (important):**

1. On **dell-runner**, re-add labels `ci,release` (see below).
2. Merge workflow changes that use `runs-on: [self-hosted, Linux, X64, ci]` and `..., release]`.
3. Register new machines with `RUNNER_LABELS=ci` only.

Re-label dell-runner on the host:

```bash
cd ~/actions-runner
export RUNNER_TOKEN="$(gh api repos/DeYinAI/deyin-desktop/actions/runners/registration-token --jq .token)"
./config.sh \
  --url https://github.com/DeYinAI/deyin-desktop \
  --token "$RUNNER_TOKEN" \
  --name dell-runner \
  --labels self-hosted,Linux,X64,ci,release \
  --unattended --replace
sudo ./svc.sh stop && sudo ./svc.sh start
```

Register a CI-only worker:

```bash
RUNNER_NAME=wsl-ci-1 RUNNER_LABELS=ci bash scripts/ci/register-linux-runner.sh
```

Workflow label changes live on branch `ci/runner-labels` until dell-runner is migrated (do not merge before step 1).

---

## Remove a runner

```bash
cd ~/actions-runner
sudo ./svc.sh stop && sudo ./svc.sh uninstall
./config.sh remove --token "$REMOVAL_TOKEN"
```

Removal token: **Settings → Actions → Runners → runner → Remove**.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Jobs stuck **Queued** | All runners busy — add another runner or cancel hung jobs (`gh run cancel <id>`) |
| Release fails on new runner | Run `bash scripts/ci/check-dell-runner.sh` (Wine/dotnet/bun missing) |
| Hung verify (>45 min) | Auto-cancelled by workflow timeout; inspect `~/actions-runner/_diag` |

See [CI.md](./CI.md) and [RELEASE.md](./RELEASE.md).
