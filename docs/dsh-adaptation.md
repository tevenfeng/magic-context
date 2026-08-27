# DeepSeek Harness Adaptation Notes

Design notes for the Magic Context ↔ DeepSeek Harness (DSH) adaptation.
Status: **Phase 0 (seam smoke) + Phase 1 (inline POC engine)** complete;
Phase 2 (async historian / no-pause) pending.

## Seam map

| Magic Context concept (OpenCode) | DSH equivalent (verified against 0.1.0-rc.6) |
|---|---|
| `experimental.chat.messages.transform` (rewrite wire messages) | ❌ NONE by design — loop-built requests are deep-frozen; the request must be a pure function of the session log (reconstructability). Mutate the **session surface** instead. |
| Historian compartmentalization | ✅ `ctx.compaction` — replaceable `CompactionEngine` service; `BasicCompactionEngine` documents `summarize()` as the sole subclass customization hook; durable replace/replay/markers/tool-pairing inherited. |
| Compaction trigger (pressure / overflow) | ✅ `agent/pre-step` waterfall (pressure) + `agent/request-error` (context-overflow, `{kind:"retry"}` semantics). Registered by `auto: true`. |
| Drop queue / `ctx_reduce` | 🔜 `ctx.tools.register` + surface replace nodes; `toolPairingBalancedAfter/Before` protect open arcs (Phase 3). |
| System prompt injection | ✅ `system-prompt/assemble` expert waterfall + `ctx.systemPrompt.section()` (Phase 3+). |
| Hidden subagents (historian/dreamer) | ✅ `ctx.agents.create` with `origin: 'subagent'` (Phase 2+). |
| Raw history reads (`opencode.db`) | ✅ Session event log; `isAppendSurfaceEvent` distinguishes the durable human transcript from model-only replacement copies. |
| TUI sidebar / RPC | ✅ Client plugins + `dsh-client-ui-slots` slot registry; `useProjection` standard props; `harness.handle`/`host.call` for package-private RPC (Phase 4). |
| Token breakdown | ✅ `ctx.tokenMeter` + `contextBreakdown`/`tokenUsage` projections + composer `ContextMeter` component — MC adds its own projection unit (Phase 4); the companion breakdown panel was removed as redundant with the built-in ContextMeter. |
| SQLite storage | ✅ `node:sqlite` (DSH is a Node ≥ 24 app). |
| Conflict handling | ✅ Profile patch layer (`cordis.patch.yml`) disables `compaction-basic`; `tool-result-pruner` is orthogonal and stays. |
| Rust ck-mc module | 🔜 Needs a DSH harness codec (`dsh-llm` Message ↔ `CkIngressMessage`) — out of scope for the context-management milestone. |

## Verified mechanics (empirical)

- **Profile composition**: `dsh.profile.bundles` (ordered bundle packages) → each
  bundle's `cordis.patch.yml` layer (entries are **`- insert:`** lists; a
  non-insert entry with an unknown id is a "patch: entry not found" warning,
  NOT an insertion) → profile `cordis.patch.yml` → `$DSH_HOME/cordis.patch.yml`
  → `--patch` overlays. Patches match by `id` and **replace the row's whole
  `config` object** (no deep merge).
- **Bundle package contract**: `package.json` declares
  `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`; the bundle export
  is a Cordis plugin (class or object). Entry `config` reaches the plugin as
  the second `apply()` argument.
- **Engine registration**: `CompactionEngine extends Service` self-registers
  under `ctx` service key `compaction`; the plugin object declares
  `inject: ["llm", "tokenMeter", "sessions"]` (mirrors Basic's static list).
- **Summarization contract**: `summarize(input, agent, signal)` receives the
  shadowed region as replayed `{system?, tools?, messages}`; the default
  implementation appends the instruction as a final user message and reuses
  the conversation's system/tools for provider KV-cache alignment. Must return
  text-only `ContentBlock[]` (images rejected); `max-tokens` finish is
  fail-closed. The caller frames the summary with `<compacted-summary>` tags +
  checkpoint preamble and synthesizes the replacement user message carrying
  `compactCheckpointSource` provenance.
- **Trigger config**: `thresholdRatio` (default 0.8 of the model's
  contextWindow), `retainRatio` (default 0.16), invariant
  **`retainRatio < thresholdRatio`** (validated at engine construction —
  a violation aborts the loader entry). `auto: true` (default) registers the
  `agent/pre-step` + `agent/request-error` hooks.
- **The pause**: `agent/pre-step` awaits `compactIfNeeded(...)` inline — the
  current DSH engine waits on the summarizer LLM before the next step
  proceeds. Removing that wait is Phase 2.
- **Local dev environment**: `DSH_HOME=<repo>/.dsh-dev` isolates profiles,
  credentials (`$DSH_HOME/.credentials.yaml`), settings
  (`$DSH_HOME/settings.yaml`) and sessions; `dsh plugin --profile <name> add
  "link:$PWD/packages/dsh-plugin"` symlinks the dev package into the profile
  (use `link:`, not `file:` — `file:` copies and pnpm's cache skips refresh).

## POC status (Phase 1) — VERIFIED END-TO-END

- `packages/dsh-plugin` builds to a ~15 KB ESM bundle (`bun build`,
  externals: `@deepseek-ai/*`, `node:*`, `jsonc-parser`).
- Boot smoke ✅: `dsh --profile mc-dev "reply with exactly: PONG"` → `PONG`
  with the engine registered and compaction-basic disabled.
- Compaction smoke ✅ (smoke8): a long headless task on this repo produced a
  946-event session with **6 `<compacted-summary>` checkpoint nodes** carrying
  MC compartment markdown (`### title (importance N, episode_type)` +
  "Durable facts" blocks), replacing the raw spans while the append-origin
  transcript stayed intact. Unit tests: 6/6.
- Diagnostics are gated behind `MC_DSH_DEBUG=1` (probe + debug file
  `.dsh-ref/mc-debug.log`); production runs are clean.

### Measured findings (smoke runs)

- **The pause baseline** (inline engine, the thing Phase 2 removes):
  summarizer latency sits on the `agent/pre-step` critical path —
  **avg 14.2 s per compaction step, max 31 s** (n=7, opencode-go flash
  summarizer). Failures (MAX_TOKENS) are the longest waits and are
  fail-closed by the inherited machinery.
- **Model resolution trap**: the routed request header can carry provider ids
  with no registered LLM adapter (observed `comateoneapi`); the summarizer
  target must be pinned to a provider that has an adapter
  (`summarizationProvider/summarizationModel`). Model ids in the Pi gateway
  settings are lowercase (`deepseek-v4-flash`).
- **Role-switch hardening**: replaying the full conversation + appending the
  historian instruction is not enough for non-reasoning models — the
  flash model kept continuing the original task until the instruction was
  rewritten to open with a hard role override ("STOP. The conversation above
  has ended..."). The hardened prompt is in `src/prompt.ts`.
- **1M context windows**: `resolveModelInfo` reports `contextWindow: 1_000_000`
  for the gateway model, so the default 0.8 threshold never fires on ordinary
  sessions; smoke used 0.02. Default thresholds must be re-derived per model
  family for DSH (Phase 2).

### Known constraint

- The bundle must NOT bundle `jsonc-parser` (its UMD build emits relative
  `require("./impl/...")` that breaks inside a bundle; keep it external — the
  profile's pnpm install provides it).

## Phase 2 — async historian / no pause: DONE, VERIFIED

Implemented and smoke-verified (smoke9):

- **Async flow**: `compactIfNeeded("pressure")` replicates Basic's pricing with
  public APIs (`tokenMeter.measure` + `session.surface.nodes` +
  `toolPairingBalancedBefore`, see `src/historian.ts#selectRange`), freezes the
  selected span, spawns a background historian (detached from the step
  AbortSignal, per-session in-flight guard), and returns `null`. The next
  pre-step commits the ready publish through the inherited `compactRegion`
  (durable replace + markers + replay unchanged); `summarize()` serves the
  frozen result on an exact span-fingerprint match — instant, no LLM.
  `context-overflow` still runs the summarizer inline (single allowed pause).
- **No-pause verification**: pre-step `compactIfNeeded` durations —
  **0ms / 0ms / 2ms (spawn) / 3ms (commit)** vs the inline baseline
  avg 14.2s / max 31s. The summarizer ran ~3.9s fully off the critical path
  (spawn 05:00:48.202 → stored 05:00:52.124 → committed 05:00:57.713, while
  the agent loop kept stepping).
- **Durability**: `mc_pending_publish` + `mc_compartments` in a separate
  SQLite db (`~/.local/share/cortexkit/magic-context/dsh-context.db`,
  `MC_DSH_DB` override; runtime selector `src/sqlite.ts` — node:sqlite in
  production, bun:sqlite under tests). Pending rows clear after commit;
  compartment rows persist for the future decay renderer.
- **Checkpoint landing**: the smoke session contains the
  `<compacted-summary>` node with MC compartment markdown + facts; the raw
  transcript is untouched.
- **Replay determinism**: holds by construction — the checkpoint is a durable
  surface event with fixed content; nothing mutates on read passes. (A
  hash-level replay test over a re-booted session log remains for the e2e
  milestone.)
- Fail-open safety: any pre-step error logs (gated) and returns `null`; the
  step loop is never blocked. MAX_TOKENS/aborted remain fail-closed inside
  the summarizer itself.
- Tests: 28/28 (`store` round-trip/durability, `fingerprint` determinism,
  `selectRange` boundary math + head-skip, decay curve invariants, parser/render
  goldens).

## Decay re-render — DONE, VERIFIED

Ported the council-validated decay curve (`src/decay.ts`, unchanged
hyperparameters; `MC_DSH_H50` test override) and wired node-level demotion:

- Each committed checkpoint becomes an independent surface node (range
  selection now SKIPS leading checkpoint nodes — verified in the session log:
  later compactions no longer fold earlier checkpoints, keeping them
  demotable).
- A fold boundary runs `runDecayPass`: age = 1-based position from newest,
  budget pressure over the 60k-token history budget; over-aged nodes are
  re-replaced (single-node `compactRegion`) with pre-rendered lower-tier text
  served through the decay-override map — no LLM, instant.
- Smoke evidence (smoke15): `decay: demoted node 241->2893 to tier 3` — the
  demotion committed, and the next compaction correctly protected node 2893
  (its shadow list does not include it).
- DSH's anti-bloat guard is respected: a replacement that is not smaller than
  the shadowed span is refused ("summary is not smaller than the shadowed
  content"). With near-uniform tier sizes from weak summarizers, demotions are
  correctly skipped — churn without shrink is pointless.
- Two off-by-one lessons recorded: `CompactionResult.summarySeq` is the
  `compaction/summary` MARKER event; the replacement `user/message` surface
  node always lands at `summarySeq + 1` (verified against the session log).
- Pre-step overhead unchanged after integration: 2–7 ms across the smoke.

**Remaining Phase 2 follow-ups** (later rounds): protected-tail boundary
tuning per model family (the 1M-window finding); hash-level replay test over
a re-booted session log.

## Phase 3 — ctx_reduce agent-driven reduction: DONE, VERIFIED

- **Marker injection**: a `tools/post-execute` listener enriches every
  normalized tool result with `[ctx §N§]` (N from a process-wide SQLite
  counter — globally unique, so no agent linkage is needed). The enriched
  content IS the durable model-visible content, so replay determinism holds
  by construction.
- **Tag resolution**: a `session/event` listener resolves tag → (session, seq)
  from the durable `tool/result` events into `mc_tags`.
- **The tool**: `ctx_reduce(tags=["§N§", ...])` via `ctx.tools.register`
  (fiber-owned, auto-disposed); idempotent drop queue in `mc_drop_queue`;
  a guidance section registers through `ctx.systemPrompt.section` (order 150).
- **Commit**: drops ride the fold boundary (`runDropPass` after a successful
  compaction commit), following the tool-result pruner's sanctioned pattern —
  a same-type `tool/result` replacement preserving the message source
  (callId), so provider tool-use/result pairing survives. Placeholder
  `[dropped §N§]` is a pure function of the tag id. Stale rows (node folded
  before the drop committed) are cleared.
- Smoke evidence (smoke17): the agent read a large file, called ctx_reduce,
  and the session shows 2 replacement events (`[dropped §2§]`, `[dropped §4§]`)
  with callIds preserved; one stale drop correctly cleared; 5 marked tool
  results in the durable log; pre-step overhead stayed 3–8 ms.
- Tests: 36/36 (marker parsing/enrichment, placeholder determinism, arg
  validation, queue idempotency, global tag monotonicity).

## Phase 4 — token breakdown: host side DONE; client panel REMOVED

- **`mcBreakdown` projection** (`src/projection.ts`): a bounded-state pure
  fold registered into `ctx.sessionProjections`, classifying surface tokens
  into checkpoint / raw / dropped buckets (+counts). Follows the token-meter's
  shadow-price protocol: `compaction/summary`/`compaction/prune` arm an
  all-raw claim; our own `mc/drop-meter` event (new `SessionEventMap` key)
  arms an exact-kind claim immediately before each drop replacement.
- **Estimator**: faithful port of the token-meter's fixed heuristic
  (CHARS_PER_TOKEN=4, BLOCK_OVERHEAD=4, framing +4) — the pure estimator is
  not exported from the shipped package, so the math is copied and unit-locked.
- Third-party `SessionProjectionMap` augmentation is not possible without a
  resolvable `.../types` subpath export, so the key widens through a cast at
  registration; the zod schema still validates every wire payload.
- Live smoke (smoke19): snapshots reconcile exactly at every fold —
  `{surface 16669, checkpoint 438, raw 3934, dropped 12297, counts 2/3}` after
  two big tool results were dropped (raw 17055 → 3934).
- **Client panel — REMOVED (user decision)**: the `⧉` button +
  combined panel in `conversation.input.right` was built (two revisions:
  first a `conversation.input.dock` strip, then a compact composer-trailing
  button beside the built-in ContextMeter) and browser-verified (all six
  rows, zero page errors). It was then removed because the harness already
  ships its own ContextMeter next to the send button — a companion breakdown
  button was redundant. The client half now ships ONLY the drop-record node
  (Phase 4b). The server-side `mcBreakdown` projection remains (observation
  only, no client consumer; still powers the debug snapshots).
- **Serving verified**: a web-based profile boots cleanly and serves
  `GET /plugins/@cortexkit/dsh-magic-context/client.js` → 200
  (`window.__ModuleLoader__` format with the correct bundle id).
- **Build-time findings** (recorded): (1) a client bundle package MUST
  export `"./package.json"` from `exports` — the client-modules scan resolves
  the manifest via `createRequire(profile anchor)`, and Node's exports
  encapsulation makes `require.resolve` fail without it; (2) the tsdown
  client entry is `src/client/index.ts` (JSX lives in sibling `.tsx` files);
  (3) in source-entry mode the preset's CSS-modules plugin is shadowed by
  tsdown's css guard — the rebuild carries a local copy of the inline plugin
  first in the plugin list. Evidence scripts: `.tools/verify-ui.mjs`
  (playwright, workspace-local browser binaries).

## Phase 4b — drop record in the conversation flow: DONE, VERIFIED

Requirement: parity with the opencode TUI — when `ctx_reduce` content is
dropped mid-conversation, the user sees a drop record at that position in the
DSH conversation flow.

- **Seam**: one `ConversationNodeDefinition` (`kind: 'mc-drop'`, target
  `chat`) + a keyed `conversation.chat.node` slot (`key: 'mc-drop'`). The
  definition folds two adjacent log events into one chat node:
  - `mc/drop-meter` (log-only meter, `role: 'start'`): carries
    `shadowedSeqs[0]` (the replaced tool result) and `rawTokens` (the shadow
    price of the dropped output).
  - the adjacent `tool/result` replacement whose content is the
    deterministic `[dropped §N§]` placeholder (`role: 'update'`): supplies the
    tag id.
  - `buildViewNode` anchors the node at the start event's seq +0.02, so it
    renders exactly where the replaced tool output was.
- **Renderer**: one compact row — `⧉ Freed from context [dropped §N§] −N tok`
  (`已从上下文释放` in Chinese) — via `ctx.locale.register('mc', …)`.
- **Server pair verified in the log**: each committed drop appends the meter
  event immediately followed by the placeholder replacement
  (e.g. meter seq 135 `{shadowedSeqs:[93], rawTokens:1089}` → replace seq 136
  `[dropped §1§]`), preserving the message source (callId) so provider
  tool-pairing survives.
- **Live path verified (headless Chromium)**: driving a real session across a
  fold boundary with queued drops, the SSE stream delivers meter + replace,
  the assembler runs start → update, and the row renders
  `⧉ Freed from context [dropped §4§] −2284 tok` — tag and token count both
  correct, zero page errors. Stale queued drops (node folded before the drop
  commit) are cleared server-side and never render.
- **History path verified**: after a page reload the same session re-renders
  the same row from the `session.history` window (meter + replace both
  match). Legacy sessions whose drops were committed by an earlier engine
  build without meter events degrade gracefully — `buildViewNode` derives the
  tag from the placeholder text of whatever matches are in-window, so the row
  still shows `[dropped §2§]` without a token count.
- **Two client bugs found and fixed during verification**:
  1. The update matcher originally claimed *every* `tool/result` replacement,
     hijacking the in-box tool-output pruner's truncation replacements and
     rendering bogus `[dropped §0§]` rows. The match now requires the
     placeholder-anchored content (`/^\[dropped §\d+§\]$/`).
  2. History windows page at append-origin boundaries: a page cut can leave
     the placeholder update without its meter start. `buildViewNode` now
     derives its payload from all matches instead of trusting state alone.
- The client bundle is rebuilt from extracted original sources (the temp
  workspace package was recreated, patched, rebuilt via the tsdown
  `clientBundle` preset, then removed — the harness checkout stays pristine)
  and committed as `client-dist/client.js` (+ map). No probe logging ships.
- Evidence scripts: `.tools/verify-drop-node.mjs`, `.tools/drive-fold.mjs`,
  `.tools/reopen-*.mjs` (playwright drivers for the fold + reload matrix);
  server-side timeline captured in `.dsh-ref/mc-debug.log`
  (`reduce: dropped §N§` / `clearing stale drop §N§` lines).

## Phase 5 — CLI setup/doctor integration: DONE, VERIFIED

- `DshAdapter` (`packages/cli/src/adapters/dsh.ts`): detection (PATH probe),
  profile manifest read/write (JSON, malformed manifests never overwritten —
  mirrors the Pi adapter's safety posture), textual patch-layer editing
  (appends `compaction-basic disabled` + `mc-compaction` entries, preserving
  user comments), `dsh plugin add` installation step (injectable runner for
  tests), version/cache probes. Harness selection now accepts
  `--harness dsh` (prompts, error text, auto-detection).
- `setup --harness dsh` (`setup-dsh.ts`): registers the bundle + patch layer,
  checks `historian.model` in the shared magic-context.jsonc.
- `doctor --harness dsh` (`doctor-dsh.ts`): five checks — dsh presence,
  bundle registration, default-engine conflict, installed version,
  historian.model — with fix guidance and exit codes.
- End-to-end smoke against the workspace-local DSH install: setup was
  idempotent on the dev profile; doctor reported a fully healthy registration
  (bundle registered, compaction-basic disabled, plugin v0.0.1-poc, routed
  model fallback flagged). Adapter unit tests: 5/5 (fresh-profile creation,
  idempotency + comment preservation, malformed-manifest refusal, install
  failure reporting, bundle removal).
- Known limitation: the registry install step (`dsh plugin add
  @cortexkit/dsh-magic-context`) requires the package to be published; until
  then the CLI reports a precise manual-install instruction.

## Overall status vs the plan

- Phase 0–3, Phase 4 host side, Phase 5: done and smoke-verified.
- Phase 4 client panel: built and browser-verified, then REMOVED by user
  decision — the harness's own ContextMeter next to the send button makes a
  companion breakdown panel redundant. The client half now ships only the
  drop-record node (Phase 4b, verified on live and history paths).
- Follow-ups: hash-level replay test over a re-booted session log;
  protected-tail tuning per model family (1M-window finding).

## Replay verification — DONE

Hash-level determinism is now locked twice over:

- Unit test (`packages/dsh-plugin/tests/replay.test.ts`): a synthetic
  mini-log (compaction fold + drop replacement) folds byte-identically across
  independent passes, and mutated logs fold differently (sensitivity guard).
- Real-session verifier (`packages/dsh-plugin/scripts/verify-replay.ts`):
  decodes a session JSONL (including packed `*-chunks` rows via
  `decodeStorageRecord`), folds the log twice, and asserts byte-identical
  derivation. Run against 6 recent smoke sessions (including decay demotions
  and ctx_reduce drops) — all `REPLAY VERDICT: byte-identical ✔`
  (largest: 7831 events, 3 checkpoints, ~74 KB derived bytes).

## Protected-tail guidance

The engine inherits Basic's retain-window pricing; per-model families the
threshold/retain knobs flow through the patch layer. With gateway models
reporting 1M-token windows the defaults (0.8/0.16) never fire on ordinary
sessions — configure per profile in `cordis.patch.yml`:

```yaml
- id: mc-compaction
  config:
    auto: true
    maxTokens: 8192
    thresholdRatio: 0.8    # fraction of the model's contextWindow
    retainRatio: 0.16      # MUST stay below thresholdRatio
    summarizationProvider: opencode-go
    summarizationModel: deepseek-v4-flash
```

Rule of thumb: `thresholdRatio × contextWindow` should land at a few tens of
thousands of tokens (MC's OpenCode default triggers at 65% of a 200k window).

## Final acceptance run (smoke20, latest build)

Combined smoke on the final dist: 3 compaction commits, 4 ctx_reduce drops
committed (§2/§4/§5/§6), projection buckets reconciling exactly at every
snapshot (888 + 15943 + 12281 = 29112), pre-step overhead 4–6 ms. All five
phases plus the replay verifier hold on the shipped artifact.

## Divergence from the OpenCode design

- **No m[0]/m[1] wire injection.** DSH requests are log-pure functions; history
  injection is in-place: each compacted span becomes one checkpoint node in
  surface order. Cache stability is guaranteed by determinism of the log
  fold, not by dual-slot layout.
- **Decay re-render** re-replaces an older compartment span with the newly
  decayed tier text — a surface mutation that rides a fold boundary,
  mirroring the OpenCode rule "decay re-tiering happens ONLY on a HARD fold".
- **`ctx_expand`** has a natural DSH home: the append-origin events of a
  shadowed span remain in the log, so expansion = replaying the raw range.

## Upstream question list (issue draft)

1. Is `ctx.compaction` (`CompactionEngine`/`compactIfNeeded`/`summarize`
   contract), `agent/pre-step`, and `session.surface` replace-generation a
   supported third-party seam for the 0.1.x line, or subject to change
   without notice? Which parts are frozen?
2. `agent/pre-step` awaits `compactIfNeeded` inline. For engines that
   summarize asynchronously (background task + commit on a later call), is
   returning `null` from `compactIfNeeded` a sanctioned fast path, and can the
   commit (surface replace) legally happen on a later `compactIfNeeded` call
   while the agent is mid-turn?
3. `sessionProjections`: is registering third-party projection units
   (`ProjectionDefinition`) and consuming them client-side via
   `useProjection` stable? May a projection unit influence the assembled
   request, or are projections observation-only?
4. Client slots: which slot keys are third-party registerable under
   `sidebar.footer.action` / composer regions, and are `slots.inject/register`
   contracts stable for 0.1.x?
5. Bundles: is the `dsh.bundle.patch` + `cordis.patch.yml` insert contract
   stable, and is disabling in-box bundles (e.g. `compaction-basic`) via the
   profile patch layer the sanctioned replacement path?
