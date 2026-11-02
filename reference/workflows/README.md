# Reference: scripted workflow versions

The slash commands in `.claude/commands/` are the portable implementation — they run
in any Claude Code session with the `Agent` tool.

These two `.mjs` files are the **original scripted form** of Job A and Job B. They
were written for a workflow runtime that provides `agent()`, `phase()`, `pipeline()`,
`parallel()`, `budget`, `log`, and `args` as globals, and returns a structured object
to a scheduled orchestrator session. If your harness has that runtime, these give you
typed phases, JSON-schema-validated agent outputs, and a token-budget guard at every
phase boundary. If it doesn't, ignore this folder — the commands do the same job.

What's different from the commands:

- Every agent output is validated against a JSON schema (`PREFLIGHT_SCHEMA`,
  `MECHANICAL_SCHEMA`, `VERDICT_SCHEMA`, …). A malformed answer fails the phase instead
  of being parsed optimistically.
- The scripts are **pure compute**: they never comment, push, or merge. They return
  `orchestratorActions` and the scheduled session performs the side effects — only
  when the relevant flag file exists.
- Constants are inlined (the runtime has no filesystem access). Keep `EXCLUDE_PATHS`,
  `EXCLUDE_CONTENT`, labels and caps in sync with `nightshift.config.json` by hand.
