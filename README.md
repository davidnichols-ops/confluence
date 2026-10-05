# Confluence

One shared objective. Concurrent tasks. Context that survives an agent restart. Evidence and human review tied to the exact result being integrated.

This prototype explores Cloudflare's concurrent-agent collaboration challenge. It uses a pure coordination engine, a local human console, and a Cloudflare Workers/Durable Object adapter with Artifacts repository operations.

## Run locally

```sh
npm install
npm run dev
```

Open http://127.0.0.1:8787. Run the labeled deterministic demo, then inspect task context, proposed changes, candidate evidence and integration history. The local demo simulates agent tasks, prepares an actual Git candidate in an isolated clone, and evaluates JSON fixture behavior against the prepared bytes. It does not invoke coding models or remote Cloudflare Artifacts.

Git commits, trees and validation reports are retained under `.local/candidates/`. Each `.bundle` contains a complete candidate history and can be cloned with `git clone /absolute/path/to/candidate.bundle restored-candidate`. A temporary checkout is removed after validation; the bundle preserves the candidate for independent inspection.

Local state persists in `.local/state.json`. The server serializes mutations and atomically replaces the saved state. Restarting the server preserves task checkpoints.

Set `CONFLUENCE_TOKEN` for a bearer token on local API requests; the UI accepts it. The server binds to loopback, checks Host/Origin and rejects client-supplied evidence. This local console represents a human operator; cloud role separation is a different authentication boundary.

## Verification

`node scripts/verify-release.mjs` runs the local suite, TypeScript check and Worker dry build sequentially, capturing raw logs and a JSON summary. Artifacts unit checks use fakes; Git and HTTP integration checks run actual local processes.

```sh
npm test
npm run typecheck
npm run worker:check
```

Passing local tests does not establish Cloudflare runtime behavior, Artifacts availability or large-scale performance. Live platform tests and measured load are required before those claims.

## Cloudflare setup boundary

`wrangler.jsonc` binds a SQLite Durable Object and Artifacts namespace. `wrangler types` generates `worker-configuration.d.ts`. Real Artifacts access needs a valid Cloudflare login or API token with the required permissions. Account access was restored after upgrade and an explicit account API token check. Live Artifacts experiments are recorded in EVIDENCE.md; no public Worker has been deployed.

Use separate Worker secrets `HUMAN_TOKEN`, `RUNNER_TOKEN` and `AGENT_TOKENS` (a JSON map from agent ID to token). `COORDINATOR_TOKEN` optionally grants one agent identity, selected by `COORDINATOR_AGENT_ID`. Credentials determine the stored actor identity and role. Missing or ambiguous credentials fail closed. Do not use the local console's shared token as a production authorization design.

The Worker API shares the `{ action: ... }` envelope with the local console. `/api/state` returns an initial State even before an objective exists. `/api/demo` is intentionally local only. Remote `/api/actions` integration returns 501 until a verified Git integration runner is connected; it must not pretend a Durable Object state update published a Git commit.

## Design boundary

Tasks capture their baseline and reasoning checkpoint. Proposed changes carry content preconditions. A candidate must be assembled against the current baseline, validated by a trusted runner and approved by a human for its exact hash before integration.

Intent overlap is advisory. Tests can miss semantic defects. This prototype is conservative about stale bases and overlapping edits, and does not promise automatic semantic merging.

Workers and Artifacts expose repository creation, inspection, forks and scoped tokens. The binding does not supply an application merge implementation. The remote integration boundary must fail closed until a Git-based integration runner can verify and publish the composed commit. No local fixture result is represented as a remote Git merge.

Build ownership and decisions: [BUILD_SPEC.md](BUILD_SPEC.md). Initial research: `discovery/`. Private onboarding snapshots are excluded from version control and must not be published.

## Completion roadmap

See [ROADMAP.md](ROADMAP.md) for ordered milestones, owners, acceptance evidence and remaining work. [docs/PUBLICATION_PROTOCOL.md](docs/PUBLICATION_PROTOCOL.md) describes the verified local bare-repository publisher and the unimplemented remote transport/recovery boundary. [docs/DEMO_SCRIPT.md](docs/DEMO_SCRIPT.md) and [docs/SUBMISSION_DRAFT.md](docs/SUBMISSION_DRAFT.md) are preparation artifacts, not attestations of a completed contest entry.

Read-only platform access check (explicit account selection prevents inherited account mismatch):

```sh
node scripts/platform-preflight.mjs --account <account-id>
# Or supply a private API token file outside version control:
node scripts/platform-preflight.mjs --account <account-id> --token-file <private-path>
```

The probe checks identity and repository listing in namespace default. It never upgrades billing or creates resources. Worker state reads require scoped credentials and use Cache-Control: no-store. ARTIFACTS_REPO can select an isolated repository for platform verification.
