# Agent Rules and Guidelines

## File Editing Rules
- **NEVER** use Python, Ruby, Node.js, bash scripts, or one-liners to edit or write files.

## Code & Formatting Guidelines
- Use whitespace where appropriate to maintain a clean, readable visual hierarchy.
- Keep stylesheets, manifests, and scripts well-formatted and easy to navigate.

## Design system

- Before any UI work in `apps/web`, read `docs/design/README.md`, `docs/design/admin-layout.md`, and the guideline in `docs/design/components/` for each component you touch.
- Use design tokens from `docs/design/tokens.json` only; no literal colors, font sizes, spacing, or radii.
- Follow the voice rules in `docs/design/README.md` for every UI string you add or change.
- `docs/design/` is the source of truth. The browsable copy at https://claude.ai/artifact/2dosjxEbr2UVjmh9ddHeVK is republished from it; never edit only the artifact.

# Work delegation

- Main agents own planning and coordination. Delegate non-planning work, including implementation, research, testing, and review, through T3 Code `delegate_task`.
- More than two subagents may run concurrently when useful, subject to the runtime concurrency limit. There is no two-subagent cap.
- If you are a subagent, don't delegate work further.
- Before delegating, call `orchestrator_capabilities` to resolve available provider instance IDs, models, and options. Prefer available Gemini agents through Antigravity providers using `gemini-3.8-flash-high`. When Gemini is unavailable or its retry policy is exhausted, prefer the Claude provider with `claude-sonnet-5-5`. When Claude is also unavailable or its rate-limit retry is exhausted, use OpenAI/Codex `gpt-6-luna` with `reasoningEffort: medium` for small tasks, or `gpt-6.1-sol` with `reasoningEffort: medium` for larger or complex work. Use no other model unless the user authorizes it. Do not hard-code provider instance IDs.
- On a confirmed rate-limit failure, ensure the failed task has stopped and preserve any partial edits before retrying.
- Give parallel tasks disjoint file scopes, enough context, and clear acceptance criteria. Require each subagent to report changed files and verification results.
- Write delegation prompts, steering messages, and scheduled task instructions in plain English with normal spacing and short paragraphs. State the task, relevant context, owned files or scope, constraints, required checks, and completion criteria explicitly.
- The main agent must specify the minimal verification in each delegation: exact commands and working directories or a concrete manual/static check, the behavior to verify, and the stopping point. For documentation-only edits, check links and referenced commands without running builds or test suites. If a new test is needed, name the target file and the specific behavior; do not ask the subagent to survey existing test patterns.
- Include this scope instruction in every delegation prompt: "Implement the assigned change. Run only the checks specified in this task and report their results. Keep changes and tests minimal; avoid unrelated improvements, speculative abstractions, exhaustive edge cases, and elaborate test infrastructure. Once the checks pass, report changed files and stop. Add or broaden a check only to investigate a concrete failure or correctness risk, and explain why."
- Retain each returned `taskId`, and check task completion and results before declaring the parent work complete.

## Subagent progress checks

- While delegated tasks are active, the main planning agent must check each task every 5 minutes using its `taskId` and recent activity. Track the last check and last meaningful progress; use scheduled wakeups when supported instead of blocking wait loops.
- Inspect the subagents to check for stalling. A `running` status alone does not prove progress, and a long-running task alone does not prove a stall.
- Check each subagent's pending questions even when its status is `running`. Use `t3_pending_request_list` and `t3_pending_request_read`, answer in-scope questions with `t3_pending_request_respond`, and verify they cleared; a steering message alone does not resolve a pending request.
- When progress has stalled, identify the cause and intervene: clarify the task, resolve an in-scope blocker, narrow repeated work, or stop and replace the failed run. Preserve partial edits and confirm the old run has stopped before assigning a replacement the same file scope. Follow the rate-limit retry policy above when applicable.
- Report unresolved blockers that need user input promptly. End progress checks when no delegated tasks remain active, and remove any temporary monitoring schedule.

# Task focus

- Don't go in loops trying to overdo a task. Do what the user asked you to do, and if something is taking too long or needs more input, ask for it.
