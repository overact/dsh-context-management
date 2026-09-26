# dsh-context-management

**English** · [简体中文](./README.zh-CN.md)

Windowed compaction, session-private notes and paged history recall for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness). The multi-window idea is borrowed from Codex, but this is **not a 1:1 port of the Codex API, and it does not promise lossless recovery of every detail**.

## Compatibility

Version **0.3.0**, verified on **DSH 0.1.7-rc.2 / Node.js ≥ 22.15**. Peer ranges are `>=0.1.7-alpha.1` with no upper bound: since 0.1.7-rc.1, DSH skips at startup any plugin whose peer range excludes the running version, so an upper bound would silently disable the plugin after a DSH upgrade. Compatibility is judged by capability instead, through the [preflight check](#preflight-check).

- Works through official DSH extension points: `@local/dsh-context-management/compaction` subclasses `BasicCompactionEngine` and overrides the `summarize()` hook and the dynamically dispatched `compactIfNeeded()`. No instance monkey-patching, no reads of Cordis internals.
- Reuses the native tool-call pairing checks, recent-turn retention, maintenance lock, cancellation, shrink check, compaction transaction, persistence and overflow retry.
- Automatic compaction is still driven by DSH's own callbacks; the plugin adds no loop of its own.
- The host plugin publishes a `contextWindows` service (session state and settings); preset engines look it up per call rather than via `inject`. Without the host, the engine behaves exactly like the native one, so a preset never loses compaction because of a missing dependency.
- `new_context` only works in presets that mount this engine; elsewhere it fails with a clear error while the notes/history tools stay usable.
- The window number only advances once DSH actually commits the replacement messages. Failures, cancellations and "nothing to compact" never report a successful switch.
- Every window switch builds a bounded handoff. By default (`handoffSummary: generated`) the native summary model is called **once** on the outgoing region and its result is wrapped in `<generated_handoff>`, together with the goal, todos, recent user instructions, recent notes and the window index. The `compaction/summary` event records the real provider/model/usage, so the cost shows up in usage accounting. If that call fails the handoff falls back to an extractive one without blocking the switch; `handoffSummary: extractive` never makes the extra call. Disabling the plugin or its tools falls back to native summaries.

## Tools

| Tool | Purpose |
| --- | --- |
| `new_context` | Request a window switch at the next safe step boundary |
| `notes_write_file` / `notes_append_to_file` / `notes_read_file` / `notes_list_files_by_prefix` / `notes_search_contents` | Session-private notes that survive window switches and restarts |
| `history_list_windows` / `history_list_items` / `history_read_item` / `history_search_contents` | Paged recall over the session's complete raw history |

## Usage

`/ctx` toggles the plugin; `/compact` runs the current compaction mode. The toggle applies to **every session of the running DSH instance**, not to a single chat tab.

When the model calls `new_context` it gets back **requested**, not a reset: the switch is scheduled for the next safe step boundary, after the current step's tool results are fully written to history. Explicit switch requests are honoured even when DSH's `auto` compaction is off.

The web "Context management" settings page uses DSH 0.1.7 `configForms` and shares its backend setting with `/ctx`. Read failures, read-only connections and failed saves are never shown as a successful toggle. Settings changes need no restart; **after upgrading the plugin code, reload the plugin or restart DSH, then refresh the page**.

## Storage and recovery

History is read straight from the caller's own immutable DSH session log:

- `item_<seq>` is a stable event address; nothing is indexed twice and old records are not dropped past 2,000 entries.
- Native tool results are linked to their names by call ID; `tool/code-dispatch` (PTC) is searchable too.
- `history_read_item` with `format: "json"` pages through complete raw events, including call arguments and metadata.
- Windows are delimited by native checkpoint-replacement events. Old events kept in the retained tail still belong to the window that produced them.

Notes are isolated per session under `self/notes/<path>`; **there is no arbitrary cross-session read/write**. They live in the plugin's own directory, `$DSH_HOME/context-management/notes/<sessionId>.json` (`$DSH_HOME` resolved by `dsh-home-paths`), independent of the session-persistence backend's private layout, and are written with DSH's atomic write and cross-process file lock. A failed write never swaps unsaved state into the cache.

After every committed window switch (automatic, `/compact` or `new_context`) the plugin writes two notes itself: `handoff.md` is replaced with the latest full, unclipped handoff (for a generated handoff, the summarizer's raw output), and `handoff-log.md` gains one line with the window, time, summary item and first line. Only the latest handoff is kept in full, because each generated summary already merges the previous one; earlier handoffs stay readable through `history_read_item`. Neither note is injected into the next handoff, whose body already carries the same text. A cancelled or failed compaction writes nothing, and a failed note write is logged without blocking the switch.

Notes load on demand, not for every session at startup. On restore, window metadata is rebuilt and that session's notes are loaded; an unfinished transient switch request is not re-executed after a restart.

Include `context-management/notes/` when backing up or migrating; **deleting a session does not delete its notes file**. Forked sessions get independent notes; parent notes are not implicitly shared.

## Limits

| Operation | Default / hard limit |
| --- | --- |
| Window handoff (`handoffMaxChars`) | 16,000 characters by default, configurable 8,000–32,000 |
| Injected notes | Up to the 8 most recent, ~1,800 characters each, within the handoff budget |
| Single note file | 1,000,000 UTF-8 bytes |
| Notes per session | 64 files / 4,000,000 UTF-8 bytes; over-limit writes are rejected, never silently evicted |
| History list / search | 20 items by default, 50 max; 400 characters per item by default, 1,000 max |
| History scan per page | Up to 2,000 events or ~2,000,000 content characters; a single large event is checked in full |
| History preview per page | Up to 12,000 characters in total, plus item metadata |
| History / note body reads | 8,000 characters by default, 20,000 max |
| Note search | Up to 10 files × 5 lines; 400 characters per line |

History queries return `has_more` and `next_cursor`; keep the same filters and order when continuing. Body reads continue with `next_offset_chars`. Search is case-sensitive unless `case_sensitive: false`.

The last four user instructions are quoted in chronological order, up to 1,000 characters each, with their event addresses, later corrections taking precedence. The handoff also keeps the active goal, open todos and a bounded set of recent notes; exact raw evidence is recovered through the history tools.


## Installation

This plugin is not published to npm; the `@local/` scope marks it as a local plugin. Using the web profile as an example:

1. Clone and install dependencies:

   ```bash
   git clone https://github.com/overact/dsh-context-management.git
   cd dsh-context-management && npm install
   ```

2. Run the [preflight check](#preflight-check) to confirm the installed DSH provides every capability the plugin needs and nothing in the profile collides with it:

   ```bash
   npm run preflight -- --profile web
   ```

3. In the profile directory (`$DSH_HOME/profiles/<profile>/`), add a local link to `dependencies` in `package.json`, then run `pnpm install` there:

   ```json
   "@local/dsh-context-management": "link:<plugin-dir>"
   ```

4. Register the plugin in the profile's `cordis.patch.yml` (see Configuration below).

5. Mount the windowing engine in the web presets (see [DSH web preset scope](#dsh-web-preset-scope)):

   ```bash
   node scripts/sync-presets.mjs --profile web
   ```

   The script re-runs the preflight before writing and leaves the profile untouched if it fails.

6. Restart DSH and refresh the page.

## Preflight check

`scripts/preflight.mjs` checks that the target DSH **actually provides** each capability the plugin uses, and that nothing in the profile collides with it. It **never compares version numbers**: the requirement list is extracted from the `lib/` sources (DSH imports, `ctx.<service>.<method>` calls, events, session-log event types, base-class hooks, tool and command names), so new usages in the code are covered without touching the check.

| Check | Level | What it verifies |
| --- | --- | --- |
| DSH imports | fail | The target DSH packages really export the functions/classes the plugin imports |
| Compaction hooks | fail | `BasicCompactionEngine`'s prototype has the methods the plugin overrides or calls (`summarize()`, `compactIfNeeded()`) |
| Host services | fail | The packages providing the services the plugin calls (`tools`, `sessions`, `commands`, `systemPrompt`, `settings`) have those methods |
| Host events, session-log types | fail | DSH still emits the events and session event types the plugin listens for |
| Web presets | fail | Some shipped preset mounts the native engine, so the windowing engine has a slot to take |
| Notes storage | fail | The notes directory under `$DSH_HOME` is writable |
| Tool and command names | fail | Neither DSH itself nor another profile plugin defines a tool or command with the same name |
| Preset ownership | fail | The profile does not already override the same presets outside the generated block |
| Web client packages and services | warn | The client packages and `configForms`/`slots`/`locale` services behind the settings page exist; without them `/ctx` still works |
| Other compaction engines | warn | Other profile plugins built on the compaction engine, to check they do not replace the same preset rows |

It exits with code 1 when any fail-level check fails. `sync-presets.mjs` runs it before writing and in `--check`; run `--check` from your DSH start-up script and every start after an upgrade re-checks the capabilities. `--remove` (rollback) skips it.

## Configuration

```yaml
- insert:
    - id: context-management
      name: '@local/dsh-context-management'
      config:
        enabled: true
        overrideCompaction: true
        injectTools: true
        defaultStrategy: window      # or native: models not listed in modelPolicies use native summaries
        modelPolicies: []            # e.g. [{ provider: deepseek, model: deepseek-chat, strategy: native }]
        handoffSummary: generated    # or extractive: no extra model call
        handoffMaxChars: 16000       # 8000–32000
```

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Enable context management for every session of this DSH instance; this is what `/ctx` toggles |
| `overrideCompaction` | `true` | Replace native summaries with window handoffs (summary + goal/todo + recent instructions + notes + window index) plus history recall |
| `injectTools` | `true` | Provide the notes/history/new_context tools; when off, native summary compaction is used |
| `defaultStrategy` | `window` | Default compaction strategy; `native` makes unlisted models use native summaries |
| `modelPolicies` | `[]` | Per exact provider/model strategy overrides; the first match wins |
| `handoffSummary` | `generated` | Body of the handoff: `generated` calls the native summary model once; `extractive` only excerpts records |
| `handoffMaxChars` | `16000` | Maximum characters of the window handoff |

`injectTools: false` removes the tools and uses native summaries, so history is never trimmed without a way to recover it. `overrideCompaction: false` keeps the notes/history tools while regular auto compaction and `/compact` use native summaries; the model can still request `new_context` explicitly.

Unloading the host plugin removes the tools, the settings registration and the `contextWindows` service; preset engines then fall back to native summaries.

### DSH web preset scope

The web host provides no global `compaction`; compaction engines live in each preset's isolated scope. The loader cannot patch rows nested in a preset's `config.plugins` by id (only `group: true` lists are indexed), and a patch cannot rename a row. So `scripts/sync-presets.mjs` copies each `dsh-web-app` preset that mounts `dsh-compaction-basic` (currently standard/ptc/cordis) **in full** into a generated block of the profile patch, swapping only that row for `@local/dsh-context-management/compaction`; presets defined by the profile itself are swapped in place.

```bash
node scripts/sync-presets.mjs            # generate/refresh (saves cordis.patch.yml.pre-sync first)
node scripts/sync-presets.mjs --check    # exit code 1 when the block is stale for the installed DSH
node scripts/sync-presets.mjs --remove   # delete the block and restore native rows (full rollback)
```

**Re-run it after every DSH upgrade**, or those three presets stay on the old definitions. Running `--check` from your DSH start-up script gives a log warning when they go stale. Do not edit standard/ptc/cordis in the web editor: the script refuses to write if it finds a same-id override outside the generated block.

## Verification

```bash
npm install
npm run verify
```

Tests need the DSH dev dependency; alternatively point `DSH_PACKAGE_DIR` at an installed `@deepseek-ai/dsh` package directory. All model responses are fixed local fixtures, so **the tests never call a paid model**. They run in a single-process Node test runner to avoid restarting the DSH test runtime.

Coverage includes the real Cordis lifecycle, DSH ToolRuntime, SettingsProvider, TokenMeter, BasicCompactionEngine and JSONL disk recovery, plus web settings binding, session isolation, tool pairing, cancellation, failure paths and capacity limits. The web tests check the state/write contract; they are not a full visual browser test.

History reads are incremental: building state for 10,000 synthetic events takes ~2.5 ms the first time, and an unchanged re-read scans **0 events** (timings are indicative only; the regression tests pin incremental reads, scan limits and output limits).

0.3.0 passes 64 tests on DSH 0.1.7-rc.2, including the preflight: a stand-in DSH missing one hook must make it report exactly that capability.

## Code layout

| Module | Responsibility |
| --- | --- |
| `lib/index.js` | Host plugin: config schema, tool and command registration, `contextWindows` service, settings changes |
| `lib/compaction.js` | Preset compaction engine, a `BasicCompactionEngine` subclass that falls back to native behaviour without the host |
| `lib/window-controller.js` / `window-engine.js` / `window-policy.js` | When to switch windows, building the handoff, per-model strategy |
| `lib/handoff-note.js` | Writing `handoff.md` and `handoff-log.md` after each committed switch |
| `lib/session-state.js` | Incremental per-session state projection (windows, goal/todo, pending requests) |
| `lib/history-store.js` / `lib/tools/history.js` | Paged session-log recall and the history tools |
| `lib/notes-store.js` / `lib/note-repository.js` / `lib/tools/notes.js` | In-memory note model, locked atomic persistence, the notes tools |
| `lib/tools/new-context.js` | The `new_context` tool |
| `lib/text.js` | Message text extraction and clipping |
| `lib/client.js` | Web settings page (lazy-CJS client module) |
| `scripts/preflight.mjs` | Pre-install capability check |
| `scripts/sync-presets.mjs` / `presets.mjs` / `dsh-env.mjs` | Preset sync CLI, preset rewriting, locating DSH and the profile |

## License

[MIT](./LICENSE)
