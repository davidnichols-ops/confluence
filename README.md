# Confluence

Confluence turns one objective into concurrent, reviewable agent work while preserving interruption context and binding evidence, approval, and remote Git publication to the same exact content hash.

Live deployment: <https://confluence.david-nichols-ops.workers.dev>

The Cloudflare path uses a Worker gateway, a SQLite Durable Object coordinator, and a persistent Artifacts Git repository. A trusted runner validates candidate bytes, publishes with `git push --force-with-lease`, confirms the advertised remote ref, and records a receipt before the coordinator advances its baseline. Authentication assigns human, runner, and named-agent roles on the server.

## Local run

```sh
npm ci
npm run dev
```

Open <http://127.0.0.1:8787>. The local scenario is deterministic: it exercises coordination, prepares a real Git candidate in an isolated clone, validates its bytes, and retains a portable bundle. Local state and candidates live under the ignored `.local/` directory.

## Verification

```sh
node scripts/verify-release.mjs
```

The verifier runs the full Vitest suite, TypeScript check, and Worker dry build in sequence and writes raw logs under ignored `logs/`. The current verified checkpoint is 84 tests in nine files, followed by clean TypeScript and Worker builds.

The real-provider proof is intentionally separate because it invokes installed external coding agents:

```sh
npx tsx scripts/provider-demo.mjs --out logs/provider-demo
```

It runs `agy` and Devin concurrently in separate disposable Git worktrees, records bounded output and SHA-256 digests, interrupts one child, and resumes from its atomic checkpoint in a fresh OS process. Missing providers cause an explicit skip; nothing is simulated.

## Cloudflare deployment

`wrangler.jsonc` defines the Worker, Durable Object, static assets, and Artifacts binding. Configure four distinct secrets before deploying:

- `HUMAN_TOKEN`
- `RUNNER_TOKEN`
- `COORDINATOR_TOKEN`
- `AGENT_TOKENS`, a JSON object mapping agent IDs to bearer tokens

```sh
npx wrangler secret bulk .local/deployment-secrets.json
npx wrangler deploy
```

Keep that file private and mode `0600`. The deployed UI accepts one scoped token at a time. Human credentials create objectives/tasks, assemble and approve candidates, and reserve publication. Agent credentials checkpoint and propose. Runner credentials record evidence and the post-push receipt. The coordinator credential manages Artifacts repository operations and short-lived Git tokens.

`publishRemoteCandidate` verifies the candidate bundle, Git commit/tree/parent, exact UTF-8 file content, runner evidence, and human approval before the lease-protected push. It fetches and re-verifies remote bytes for crash-safe idempotent recovery. Bootstrap and minted repository tokens are revoked rather than discarded.

The browser never receives deployment secrets automatically. `/api/state` is private and returns `Cache-Control: no-store`; unauthenticated requests fail closed.

## Evidence and boundaries

[EVIDENCE.md](EVIDENCE.md) records observed results and limitations. [docs/PUBLICATION_PROTOCOL.md](docs/PUBLICATION_PROTOCOL.md) specifies the publication contract. [docs/DEMO_SCRIPT.md](docs/DEMO_SCRIPT.md) is the recording plan, and [docs/SUBMISSION_DRAFT.md](docs/SUBMISSION_DRAFT.md) contains form-ready copy.

The measured demonstration proves two-provider overlap and one fresh-process recovery. It does not claim massive scale, automatic semantic merging, or that tests can establish arbitrary software correctness. The contest entry, eligibility attestation, personal details, video approval, and acceptance of terms remain human actions.

MIT licensed. See [LICENSE](LICENSE).
