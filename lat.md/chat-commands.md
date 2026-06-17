# Slash command execution

Typed slash commands (`/compact`, `/compress`, `/reset`, `/web`, …) are run through the gateway's command pipeline, not submitted to the model as plain prompt text. This is what makes them *do* something instead of being echoed back as prose.

The desktop talks to the hermes-agent gateway over JSON-RPC. A normal message goes via `prompt.submit`, which the gateway treats as a user turn — so a literal `/compact` reaches the model and comes back as text. Real commands must instead go through `slash.exec` (registry-backed worker) with a `command.dispatch` fallback for commands that resolve to an alias, plugin, skill, or an agent prompt.

## Routing pipeline

The pure routing logic lives in [[src/renderer/src/screens/Chat/slashExec.ts#executeSlash]]: try `slash.exec`, and on rejection fall back to `command.dispatch`, returning a `SlashExecOutcome` of `done` (output rendered), `send` (resolved to an agent prompt the caller should stream), or `error`.

It mirrors hermes-agent's reference client (`web/src/lib/slashExec.ts`) so every front-end implements the same contract. Returning the `send` directive rather than dispatching it keeps the streaming turn lifecycle (loading state, active turn, `prompt.submit`) in the caller.

## Local vs gateway commands

Commands flagged `local: true` or in the `info` category are handled entirely in the renderer and never reach the gateway; everything else is routed through the pipeline.

A handful of commands (`/new`, `/clear`, `/fast`, `/usage`) are resolved client-side by `useLocalCommands`. The submit handler [[src/renderer/src/screens/Chat/hooks/useChatActions.ts#useChatActions]] checks those first, then routes any remaining `/…` text through the dashboard transport's slash pipeline — falling back to plain-text send only on the legacy (non-dashboard) transport.
