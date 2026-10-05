# Confluence submission copy

## Project vision

Coding agents are fast until several of them touch one goal. Then the expensive failures are coordination failures: duplicated work, stale assumptions, vanished reasoning after interruption, and validation attached to a different result than the one finally merged.

Confluence gives a human lead one review surface for concurrent agent work. Every task records intent, owned paths, its baseline, and a restart checkpoint. Agents propose content with preconditions. The coordinator assembles one candidate, rejects conflicts and stale work, and binds trusted validation plus explicit human approval to its exact SHA-256 content hash. Only that approved candidate may advance the remote Git baseline.

## How Cloudflare is used

A Cloudflare Worker is the authenticated gateway and serves the review UI. A SQLite Durable Object serializes the shared objective, tasks, checkpoints, candidate, evidence, approval, publication reservation, receipt, and audit log. Cloudflare Artifacts stores the authoritative Git baseline and supplies short-lived repository-scoped credentials.

The trusted runner verifies the candidate’s bundle and actual Git objects in isolation, reconstructs every committed byte, then publishes through Artifacts smart HTTP with `git push --force-with-lease`. It confirms the remote ref before recording a receipt. If the runner dies after push, retry fetches and re-verifies the remote commit, so recovery cannot invent success.

## Observed result

The deployed product is available at <https://confluence.david-nichols-ops.workers.dev>. A production path published commit `52b1edaba237676bacd69c73e072bc8a001d08fb` to the persistent `confluence-baseline` Artifacts repository and recorded the matching receipt at coordinator revision 1. Unauthenticated state access is rejected.

Public source: <https://github.com/davidnichols-ops/confluence>.

Real `agy` and Devin processes produced useful commits in isolated worktrees with overlapping measured execution intervals. A third provider process was intentionally stopped, checkpointed, and resumed successfully in a different OS process. The release verifier passes 84 tests in nine files, TypeScript, and a Worker dry build.

## Run and review

```sh
npm ci
node scripts/verify-release.mjs
npm run dev
```

Open <http://127.0.0.1:8787> for the deterministic local workflow. The external-provider proof is `npx tsx scripts/provider-demo.mjs --out logs/provider-demo` and requires installed `agy` and Devin CLIs. Deployment instructions and required secrets are in README.md.

## Honest scope

The measured claim is two concurrent provider processes and one restart recovery. Confluence does not claim arbitrary semantic merging or massive scale. Same-file conflicts fail closed; a human decides what proceeds. The trusted runner is part of the security boundary.

## Human fields still required

Add team/contact/location/attendee details and the approved 5–10 minute video. Confirm eligibility, rights, and the official terms personally. License: MIT.
