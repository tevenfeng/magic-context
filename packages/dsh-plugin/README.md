# @cortexkit/dsh-magic-context

Magic Context for **DeepSeek Harness** — self-managing context without compaction pauses.

**Status: async historian + decay + ctx_reduce verified; drop records render
in the conversation flow; the token-breakdown panel was removed — the
harness's own ContextMeter next to the send button covers it.**

- The pre-step path never waits on the summarizer LLM (measured overhead
  0–8 ms vs the inline baseline avg 14.2 s).
- Checkpoint nodes decay deterministically at fold boundaries.
- `ctx_reduce` marks tool outputs for removal; drops commit at fold
  boundaries as same-type replacements (provider tool-pairing preserved).
- Every committed drop leaves a visible record in the conversation flow
  (`⧉ Freed from context [dropped §N§] −N tok`), like the opencode TUI.
- The `mcBreakdown` session projection classifies surface tokens into
  checkpoint / raw / dropped buckets (server-side accounting and debug
  snapshots; no client panel consumes it).

## Install (dev profile)

```sh
# 1. Create a dev profile and install this package into it (forwards to pnpm)
dsh plugin --profile mc-dev add "file:$PWD/packages/dsh-plugin"

# 2. Add the bundle to the profile manifest
#    $DSH_HOME/profiles/mc-dev/package.json:
#      "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless", "@cortexkit/dsh-magic-context"] } }

# 3. Disable the default compaction engine in the profile patch layer
#    $DSH_HOME/profiles/mc-dev/cordis.patch.yml:
#      - id: compaction-basic
#        disabled: true

# 4. Boot
DSH_HOME=... dsh --profile mc-dev "run a long task"
```

The historian model resolves from `.cortexkit/magic-context.jsonc`
(`historian.model: "provider/model"`), falling back to the session's routed
model. The project config file is shared with the OpenCode/Pi plugins.
Diagnostics: `MC_DSH_DEBUG=1` (debug file `.dsh-ref/mc-debug.log`), SQLite at
`MC_DSH_DB` (default `~/.local/share/cortexkit/magic-context/dsh-context.db`).

## Client half — drop records only

The client half is the in-conversation drop record: a `ConversationNode`
definition (`mc-drop`) renders one compact row
`⧉ Freed from context [dropped §N§] −N tok` (`已从上下文释放` in Chinese)
at each dropped tool output's position. The token-breakdown panel was
removed by design decision — the harness already ships its own ContextMeter
next to the send button, and a companion breakdown button was redundant.

- Source lives in the DSH monorepo build conventions (entry
  `src/client/index.ts`, JSX in sibling `.tsx`); the built artifact is
  committed as `client-dist/client.js` (+ map) and copied into `dist/` by
  `bun run build`. Rebuild it with a temporary workspace package inside a
  deepseek-harness checkout using the `clientBundle` tsdown preset (plus a
  local copy of the preset's CSS-inline plugin first — tsdown's css guard
  shadows it in source-entry mode).
- `package.json` declares `dsh.client` (inject: runtime + api-remotes +
  ui-conversation, platform web) and exports `./client` — and MUST export
  `./package.json`, which the client-modules manifest scan resolves through
  `require.resolve`.
- Verified: a web profile serves
  `GET /plugins/@cortexkit/dsh-magic-context/client.js` (200); headless
  Chromium confirms the drop rows render on the live path (SSE mid-turn)
  and the history path (page reload), with correct tags and token counts
  and zero console errors.
- The match only claims placeholder-anchored replacements, so the in-box
  tool-output pruner's truncation replaces are never hijacked; page-cut
  windows (a replacement loaded without its meter) still render the tag from
  the placeholder text.
- The committed `client-dist/client.js` ships no probe logging.


## Verification

- `bun test` — 45 tests: parser/render goldens, decay invariants, range
  selection, fingerprint determinism, store round-trips, ctx_reduce queue
  idempotency, projection fold (claims, replaces, drift tolerance).
- Long headless session: `<compacted-summary>` checkpoint nodes with
  compartment markdown; `[dropped §N§]` replacements with preserved callIds;
  `mcBreakdown` snapshots whose buckets reconcile exactly.

## Design notes

See `docs/dsh-adaptation.md` for the seam map, the no-pause invariant, and the
divergence from the OpenCode design (in-place surface replaces instead of
m[0]/m[1] wire injection).
