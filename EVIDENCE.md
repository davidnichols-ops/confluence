# Confluence evidence — October 4, 2026

This file separates observed behavior from product claims. Raw machine logs are stored in ignored `logs/`; the public repository contains the commands and scripts needed to reproduce them without publishing credentials.

## Release verifier

`node scripts/verify-release.mjs` completed in 24.439 seconds:

- Vitest: **84 tests passed in nine files**, exit 0, 22.139 seconds.
- TypeScript `tsc --noEmit`: exit 0, 1.093 seconds.
- Wrangler dry build: exit 0, 1.204 seconds; Durable Object, Artifacts, repository-name, and coordinator-ID bindings present.

The test suite uses real temporary Git repositories and real local HTTP processes where those boundaries matter. Artifacts binding unit tests use fakes; the live checks below cover the platform boundary.

## Cloudflare and Artifacts

The deployed endpoint is <https://confluence.david-nichols-ops.workers.dev>. Final checked Worker version: `98ab4228-0606-4113-bed8-a3a8216748ef`.

Observed live results:

- UI returned HTTP 200.
- Unauthenticated `/api/state` returned HTTP 401.
- Authenticated state returned `mode: cloudflare`, revision 1, `Cache-Control: no-store`, and a persisted published receipt.
- Persistent Artifacts repository `confluence-baseline`, default branch `main`, was readable through the binding.
- A short-lived read token was minted with an ID and revoked through the deployed Worker.
- Earlier disposable platform testing exercised repository create, HTTPS Git seed/push, file/log reads, fork, read/write scope rejection, revocation rejection, and confirmed cleanup.

The end-to-end deployed publication advanced Artifacts from `6ae44e2542c50215dd9c231d6608f78c3ce93321` to `52b1edaba237676bacd69c73e072bc8a001d08fb`. The Git tree was `f0a877321b29ad577a843439ac52ddbff4a9813e`; the Confluence content hash was `ac942d75b99228ec135bfdda2dd946430d08e7d975029b6a5eda8a5fb6b7b8d6`. Retrying the same receipt left coordinator revision 1, proving application-level idempotence. The publication runner also confirms the advertised remote ref after push.

A separate live crash-window proof published a root candidate to a temporary branch, retried with the original zero expected head, fetched and re-verified the already-advertised commit, and returned an idempotent receipt whose `previousHead` remained the original reservation value. The branch deletion was confirmed and the write token revoked. This caught and fixed an earlier receipt-contract mismatch before release.

One bootstrap token appeared in local tool output during initial repository creation. It was revoked immediately; all subsequently created/minted tokens are revoked by code or cleanup. No token value is tracked.

## Real providers and interruption recovery

`scripts/provider-demo.mjs` invoked installed providers against disposable, separate worktrees:

- `agy` parse task: completed in 122.789 seconds, commit `a5bd0babdf9cc3b4b322445e94717bee9838575c`.
- Devin format task: completed in 25.055 seconds, commit `ca3ce5d0e3d3454b3776cc581f0d68f99313d75c`.
- Both began four milliseconds apart, so their half-open execution intervals overlap.
- `agy` Roman-numeral task: intentionally interrupted after 30.337 seconds. Its checkpoint retained bounded stdout/stderr SHA-256 digests and partial context.
- Resume: completed in a fresh OS process after 120.482 seconds, with attempt 2 and matching `resumeOf` lineage; commit `1ea74cdd8156e5a929fc998913351d3db1948d16`.

The agy worktrees were clean. Devin committed the requested file but left unrelated uncommitted workspace metadata; evidence records `clean: false` rather than hiding it. The worktrees were disposable and isolated, so those extras never entered this repository or a candidate.

## Correctness properties exercised

- Server-bound identity and distinct human, runner, coordinator, and named-agent credentials.
- Content preconditions, stale-baseline rejection, same-file conflict rejection, and candidate invalidation after proposal changes.
- Exact SHA-256 binding across candidate evidence, approval, publication reservation, and receipt.
- Bundle checksum/head validation, actual Git commit/tree/parent inspection, full UTF-8 regular-file reconstruction, and credential-free receipt remotes.
- Atomic local `update-ref` and remote `--force-with-lease` races.
- Post-push advertised-ref confirmation and fetch/reverification on idempotent retry.
- Provider cwd allowlists, explicit argv without a shell, bounded runtime/output, full-stream digests, atomic checkpoint writes, concurrency limits, and tamper rejection.

## Limits

The provider measurement covers two concurrent processes and one recovery; it is not a scale benchmark. Tests and fixture checks do not prove general semantic correctness. Confluence rejects direct same-file overlap and does not promise automatic semantic merging. A trusted runner remains part of the security boundary. The contest form and eligibility statements have not been submitted.
