You are performing a **full engineering audit of this DEYIN DESKTOP  codebase**.

The goal is not simply to find obvious bugs. Review the entire system and determine whether the IDE is:

* Functionally correct
* Architecturally clean
* Lightweight and fast
* Free from duplicated functionality
* Free from conflicting implementations
* Properly modular
* Easy to maintain
* Scalable for future features
* Correctly wired end-to-end
* Production-ready

The intended product should feel similar in philosophy to a lightweight coding IDE such as Zcode: minimal unnecessary complexity, fast startup, efficient resource usage, but with strong extensibility through MCP, Skills, Plugins, packages, and future integrations.

Do not assume existing code is correct simply because it compiles.

# 1. Understand the Entire Architecture

First inspect the complete repository before recommending changes.

Identify:

* Application entry points
* Core runtime
* UI/frontend architecture
* Backend/runtime services
* State management
* Package structure
* Internal packages
* Shared utilities
* Configuration system
* Dependency injection/service system
* Extension/plugin architecture
* MCP implementation
* Skills implementation
* AI/provider integration
* Command/tool system
* File system integration
* Terminal integration
* Editor integration
* IPC/RPC/message buses
* Build system
* Development tooling
* Production packaging
* Tests
* Logging/error handling
* Authentication/security boundaries if applicable

Create a mental dependency map of how these components interact.

Determine whether each component has a clear responsibility.

# 2. Check for Duplicate Implementations

Search the entire repository for functionality that has been implemented more than once.

Look specifically for:

* Duplicate services
* Duplicate API clients
* Duplicate MCP handling
* Duplicate skill loaders
* Duplicate plugin loading logic
* Duplicate configuration parsing
* Duplicate state management
* Duplicate command registration
* Duplicate event systems
* Duplicate file utilities
* Duplicate model/provider handling
* Duplicate tool execution logic
* Duplicate validation
* Duplicate types/interfaces
* Duplicate schemas
* Duplicate constants
* Duplicate helper functions
* Old implementations that are still present after refactors

Determine whether similar-looking implementations are intentionally separate or accidental duplication.

Where duplication exists:

1. Identify the canonical implementation.
2. Determine whether the others can be removed.
3. Consolidate shared logic where appropriate.
4. Avoid creating giant abstraction layers merely to remove a few repeated lines.

The objective is **less code and fewer moving parts**, not abstraction for its own sake.

# 3. Detect Architectural Clashes

Look for systems that overlap or compete with each other.

Examples:

* Two state management systems controlling the same state
* Multiple configuration sources overriding each other unexpectedly
* Plugin and core code registering the same command
* Skills and plugins implementing overlapping functionality
* MCP tools exposed in multiple places
* Multiple event buses
* Multiple dependency containers
* Multiple lifecycle managers
* Frontend and backend both independently maintaining the same state
* Package-level code bypassing the core architecture
* Direct imports where an extension boundary should exist
* Circular dependencies
* Hidden global state
* Race conditions during startup/shutdown

Explain any conflicts and recommend a single clear ownership model.

# 4. Core Architecture Review

Review the `core` system carefully.

The core should contain only functionality that genuinely belongs in the base IDE.

Check whether:

* Core responsibilities are clearly defined.
* Optional functionality has leaked into core.
* Core depends on plugins when plugins should depend on core.
* Core APIs are stable and minimal.
* Internal implementation details are unnecessarily exposed.
* Core modules have excessive coupling.
* Core startup is doing unnecessary work.
* Core modules can be independently tested.
* Core remains lightweight as additional features are installed.

Prefer:

Core → extension API → plugins/features

Avoid:

Core ↔ plugins ↔ packages ↔ random shared services

There should be a clear dependency direction.

# 5. Package Structure

Review every package/workspace/module.

For each package determine:

* What is its purpose?
* Is that purpose still required?
* Does another package already do the same thing?
* Is it importing more than it needs?
* Is its public API too large?
* Should it be internal?
* Should it be merged with another package?
* Should functionality be extracted from it?
* Does it introduce unnecessary dependencies?
* Is it used anywhere?
* Is it included unnecessarily in the final bundle?

Identify unused packages and dead code.

Check workspace/package dependency graphs for circular or unnecessary dependencies.

# 6. MCP Full Audit

MCP is a major part of the system.

The IDE has its **own local MCP runtime/server implementation**.

Audit the complete MCP lifecycle.

Verify:

* Local MCP starts correctly.
* MCP shuts down correctly.
* Restart/reconnect behaviour works.
* MCP server discovery works.
* MCP configuration loads correctly.
* Multiple MCP servers can coexist.
* STDIO MCP works correctly if supported.
* HTTP/streaming MCP works correctly if supported.
* MCP client/server boundaries are correct.
* MCP tools are discovered.
* MCP tool schemas are parsed correctly.
* Tool parameters are validated.
* Tool execution works end-to-end.
* Tool results return correctly to the AI runtime.
* MCP resources work if supported.
* MCP prompts work if supported.
* Errors propagate correctly.
* Timeouts exist.
* Cancellation works.
* Dead MCP processes are cleaned up.
* Duplicate MCP processes cannot accidentally start.
* Reconnect loops cannot consume excessive CPU.
* MCP does not block the IDE startup.
* MCP logs are useful without being noisy.
* MCP configuration changes are handled safely.
* Security boundaries exist around local command execution.

Trace at least one MCP tool call completely:

AI request
→ tool discovery
→ tool selection
→ tool invocation
→ local MCP transport
→ MCP server
→ result
→ IDE runtime
→ model/tool response

Confirm that there are no disconnected or placeholder pieces.

# 7. Skills System

Review the complete Skills implementation.

Verify:

* Skills are discovered correctly.
* Skill metadata is parsed correctly.
* Skill instructions are loaded correctly.
* Skills are activated at the correct time.
* Skills are not unnecessarily loaded into every request.
* Skill selection is deterministic where required.
* Multiple skills can coexist.
* Skill conflicts are handled.
* Duplicate skills are detected.
* Invalid skills fail gracefully.
* Skills can be added without modifying core.
* Skills have a clearly defined interface.
* Skill loading does not significantly increase startup time.
* Skill context does not unnecessarily inflate model context.
* Skill state does not leak between unrelated sessions.
* Skill permissions are appropriately constrained.

Determine whether Skills, Plugins, Tools and MCP have clearly different responsibilities.

There should not be four different systems solving the same extension problem.

# 8. Plugin System

Review the plugin architecture as if the ecosystem could eventually contain hundreds or thousands of plugins.

Check:

* Discovery
* Registration
* Activation
* Deactivation
* Lifecycle
* Dependencies
* Version compatibility
* API contracts
* Permissions
* Isolation
* Error handling
* Lazy loading
* Unloading
* Updating
* Configuration
* Plugin-specific storage
* Command registration
* Tool registration
* UI contributions
* MCP contributions if allowed
* Skill contributions if allowed

One broken plugin should not break the entire IDE.

Plugins should preferably be **lazy-loaded** when possible.

Check whether a plugin can accidentally:

* Override core behaviour
* Register duplicate commands
* Leak memory
* Leave background processes running
* Block startup
* Crash the host
* Access APIs it should not access
* Conflict with another plugin

Recommend architectural improvements needed for a scalable plugin ecosystem.

# 9. Extension Model

Evaluate whether the relationship between these concepts is clear:

* Core
* Packages
* Plugins
* Skills
* MCP
* Tools
* Commands
* Providers

Each should have a defined purpose.

If responsibilities overlap, propose a cleaner hierarchy.

For example, determine whether the system should conceptually follow something like:

IDE Core
→ Extension Host
→ Plugins
→ Skills / Tools / Commands / MCP integrations

Do not force this architecture if the current implementation has a better design. Base recommendations on the actual repository.

# 10. End-to-End Feature Verification

Do not review files in isolation.

Trace major features from UI to underlying implementation.

For every important feature verify:

UI action
→ command/event
→ service
→ state update
→ backend/runtime
→ result
→ UI update

Look for:

* Buttons that call nothing
* Dead menu items
* Missing handlers
* Stub functionality
* Placeholder implementations
* Features wired only partially
* State that updates but is never rendered
* Backend functions with no callers
* UI components using obsolete APIs
* Silent error paths

Identify features that appear implemented but do not actually function end-to-end.

# 11. Build System

Run and inspect the complete build process.

Verify:

* Clean dependency installation works.
* Development build works.
* Production build works.
* Type checking passes.
* Linting passes.
* Unit tests pass.
* Integration tests pass.
* Packaging works.
* Production startup works.
* Fresh installation works.
* No hidden local-machine assumptions exist.
* Environment variables are documented and handled correctly.
* Generated files are handled correctly.
* Build artifacts contain only required files.

Inspect warnings as well as errors.

Do not dismiss warnings automatically.

# 12. Dependency Audit

Review dependencies across every package.

Identify:

* Unused dependencies
* Duplicate libraries solving the same problem
* Very large libraries used for tiny functionality
* Dependencies imported only in development but bundled in production
* Version mismatches
* Multiple versions of the same package
* Deprecated packages
* Unmaintained packages
* Dependencies that could be replaced with platform/native functionality
* Dependency chains significantly increasing bundle size

Keep the IDE lightweight.

Do not remove useful dependencies merely to reduce dependency count.

# 13. Performance Review

Check performance throughout the IDE.

Focus on:

* Cold startup
* Warm startup
* Memory consumption
* CPU usage while idle
* Event-loop blocking
* UI rendering
* Large repositories
* File watching
* Search/indexing
* MCP processes
* Plugin loading
* Skill loading
* AI requests
* Tool invocation
* Terminal processes
* Background workers

Look specifically for:

* Work performed during startup that could be lazy
* Unbounded loops
* Excessive polling
* Duplicate filesystem watchers
* Duplicate network requests
* Repeated parsing
* Excessive serialization
* Large objects retained in memory
* Memory leaks
* Unnecessary React/component re-renders if applicable
* N+1 operations
* Excessive logging
* Repeated MCP discovery
* Repeated Skill parsing
* Repeated plugin scanning

The IDE should remain responsive even with many extensions installed.

# 14. Concurrency and Lifecycle

Review lifecycle and concurrency behaviour.

Check:

* Startup order
* Shutdown order
* Background processes
* Child processes
* Workers
* MCP processes
* File watchers
* WebSockets
* Streaming requests
* Tool calls
* Cancellation
* Abort signals
* Cleanup handlers

Look for processes or listeners that are created but never destroyed.

Check for duplicate initialization when:

* Windows reopen
* Workspaces change
* Settings change
* Plugins reload
* MCP reconnects
* Development hot reload occurs

# 15. Error Handling

Review error handling across the entire application.

Check for:

* Empty catch blocks
* Errors swallowed silently
* Generic `catch` handling everything
* Missing user feedback
* Missing structured logging
* Missing retries
* Infinite retries
* Missing timeout handling
* Unhandled promises
* Process crashes caused by recoverable failures

Errors from optional systems such as plugins, MCP servers or Skills should generally not take down the main IDE.

# 16. Security Review

Review relevant security boundaries.

Particularly inspect:

* MCP command execution
* Shell commands
* Terminal execution
* Plugin permissions
* File access
* Workspace trust
* Path traversal
* Arbitrary code execution
* Environment variables
* Tokens/API keys
* Logs containing credentials
* Local servers
* Network listeners
* WebViews/browser contexts if applicable
* IPC boundaries
* Unsafe deserialization
* Dependency execution

Do not weaken functionality unnecessarily, but clearly identify dangerous trust boundaries.

# 17. Types and Contracts

Review shared types and API contracts.

Check:

* Duplicate types
* `any`
* unsafe casts
* inconsistent schemas
* frontend/backend contract mismatch
* MCP schema mismatch
* plugin API mismatch
* outdated interfaces
* optional values being treated as required
* runtime validation missing where external data enters the system

Prefer one canonical definition where practical.

# 18. Dead Code and Historical Artifacts

Search for:

* Deprecated implementations
* Old feature versions
* commented-out blocks
* TODO implementations that are now obsolete
* compatibility layers no longer required
* abandoned experiments
* unused environment variables
* unused configuration keys
* unused exports
* unused interfaces
* orphan files
* test-only code included in production

Do not delete something merely because static analysis says it is unused without checking dynamic/plugin usage.

# 19. Code Quality

Look for unnecessary complexity.

Flag:

* Giant files
* Giant classes
* functions with too many responsibilities
* excessive nesting
* excessive wrappers
* excessive factories
* unnecessary abstractions
* excessive event indirection
* unclear naming
* hidden side effects
* mutable global state
* magic strings
* inconsistent patterns

Prefer straightforward code that another engineer can understand quickly.

# 20. Tests

Determine whether tests actually protect the important parts of the IDE.

Critical systems should have tests around:

* Core startup
* Configuration
* Plugin lifecycle
* Skill discovery/loading
* MCP lifecycle
* MCP tool invocation
* AI tool execution
* command registration
* workspace loading
* build/package initialization
* error isolation

Add tests where a regression would otherwise be easy.

Avoid meaningless tests that simply mirror implementation details.

# 21. Scalability

Review the system assuming future usage includes:

* Hundreds of plugins
* Hundreds of Skills
* Many MCP servers
* Multiple AI providers
* Multiple open projects
* Large repositories
* Long-running IDE sessions

Identify architectural decisions that work now but will fail at scale.

Look for global registries, linear scans, repeated filesystem operations, synchronous startup operations and unbounded caches.

# 22. Lightweight IDE Requirement

A major goal is keeping the IDE lightweight.

For every subsystem ask:

**Does this need to be running right now?**

Prefer:

* Lazy initialization
* On-demand activation
* Shared services
* Small interfaces
* Minimal background polling
* Event-driven architecture
* Efficient caching
* Clear process ownership
* Few global services

Avoid turning the IDE into a collection of constantly running background services.

# 23. Repository Consistency

Check consistency across the repository:

* Naming conventions
* Folder structure
* configuration patterns
* error patterns
* async patterns
* import patterns
* API design
* event naming
* logging
* package manifests
* TypeScript configuration
* test organization

Do not refactor purely for stylistic preference unless inconsistency materially affects maintainability.

# 24. Run the System

Where the environment allows it, actually run:

* Dependency installation
* Typecheck
* Lint
* Tests
* Development build
* Production build
* Application startup

Also test representative workflows.

Do not conclude that something works purely by reading the code when it can reasonably be executed.

# 25. Fix Issues

After completing the initial audit, fix issues that can be fixed safely.

Prioritize:

1. Broken functionality
2. Incorrect wiring
3. Build failures
4. Runtime failures
5. Data loss/security problems
6. MCP problems
7. Plugin/Skill lifecycle problems
8. Duplicate/conflicting implementations
9. Performance problems
10. Dead code
11. Architectural cleanup

Do not perform large speculative rewrites unless necessary.

Preserve existing working behaviour.

# 26. Re-Test After Changes

After changes are made:

* Re-run type checking.
* Re-run linting.
* Re-run tests.
* Re-run production build.
* Verify application startup.
* Re-test affected features.
* Verify MCP.
* Verify Skills.
* Verify plugin loading.

Check that fixing one subsystem did not break another.

# 27. Final Architecture Review

After fixes, review the repository again.

Ask:

* Is there now one obvious implementation for each responsibility?
* Are extension boundaries clear?
* Is core still lightweight?
* Can plugins be added without modifying core?
* Can Skills be added without modifying core?
* Can MCP servers be added without modifying core?
* Are dependencies flowing in the correct direction?
* Can optional components fail without taking down the IDE?
* Is startup work minimal?
* Are lifecycle ownership and cleanup obvious?
* Is the architecture understandable without tribal knowledge?

# Required Final Report

Produce a report containing:

## Overall Health

Score the project from **0–10** for:

* Architecture
* Code quality
* Build reliability
* Runtime reliability
* Performance
* MCP implementation
* Skills implementation
* Plugin architecture
* Extensibility
* Maintainability
* Security
* Production readiness

## Critical Issues

Anything that can cause:

* crashes
* corrupted state
* broken builds
* broken MCP
* broken extensions
* security problems
* major performance problems

Include exact files/modules involved.

## Architectural Problems

Explain structural problems and why they matter.

## Duplication / Conflicts

List duplicated or overlapping implementations and identify which implementation should become canonical.

## Dead Code

List code/packages/components that appear safe to remove and explain why.

## MCP Status

Explicitly state:

* What works
* What is partially working
* What is broken
* What is not wired
* What should be improved

## Skills Status

Explicitly state the same for Skills.

## Plugin System Status

Explain whether the current architecture can realistically scale to a large extension ecosystem.

## Build Status

Report the actual result of:

* install
* typecheck
* lint
* tests
* dev build
* production build
* application startup

Do not write "working" unless it was actually verified.

## Performance Findings

Identify unnecessary startup work, memory/CPU problems and potential bottlenecks.

## Changes Made

For every modification provide:

* File
* Problem
* Change
* Reason

## Remaining Recommendations

Separate recommendations into:

**P0 — Must fix**

**P1 — Should fix**

**P2 — Optimization**

**P3 — Future architecture**

# Important Rules

* Inspect the actual repository. Do not give generic advice.
* Follow code paths before declaring something unused.
* Search globally before creating a new implementation.
* Prefer modifying an existing canonical implementation over creating another one.
* Do not duplicate functionality.
* Do not introduce unnecessary frameworks.
* Do not over-engineer.
* Keep the IDE lightweight.
* Preserve backwards compatibility where practical.
* Prefer simple architecture.
* Prefer lazy loading.
* Prefer clear ownership.
* Do not hide errors to make tests/builds pass.
* Do not disable tests, lint rules or type checks simply to achieve a green build.
* Do not use `any` or unsafe casts merely to suppress errors.
* Do not claim something is fixed until it has been verified.
* When uncertain about an implementation, trace its callers and runtime behaviour before modifying it.

The final objective is a **small, clean, reliable IDE foundation** where Core, Packages, Plugins, Skills and MCP have clear responsibilities and the architecture can grow without accumulating duplicated systems or unnecessary complexity.
