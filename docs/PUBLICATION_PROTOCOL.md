# Git publication protocol

Status: implemented and verified for **local bare repositories only**. No network, no remote push, no claim of a remote Artifacts merge.

## Scope

`publishGitCandidate` (src/git-publication.ts) installs one immutable prepared candidate into an explicitly supplied **existing local bare repository**. The prepared candidate comes from `prepareGitCandidate` (src/git-runner.ts), which returns `{ commit, tree, contentHash, passed, checks, bundle }`; this module imports that definition structurally (`PreparedCandidate`) and never re-derives or mutates it. It does not modify git-runner, contracts, core or worker.

## Input contract

- `repository` — path to an existing local bare repository. URLs (`://`), non-bare repositories and missing directories are rejected (`invalid_repository`).
- `ref` — must be a safe branch under `refs/heads/` (the demo flow uses `refs/heads/main`). Tags, `HEAD`, `.lock` suffixes, `..`, control/space/special characters are rejected (`invalid_ref`).
- `expectedHead` — the ref value the caller believes is current, used as the compare-and-swap old value. The all-zero object id is only accepted to create a branch that does not exist yet, and only for a root-commit candidate (`invalid_head`, `stale_head`).
- `candidate` — `{ commit, tree, contentHash }` claims, verified against the bundle's actual objects, never trusted as-is.
- `bundle` — the portable bundle bytes produced at preparation time.
- `evidence` — runner evidence `{ treeHash, passed, checks, runner }`. Must have `passed: true` (`evidence_failed`) and `treeHash` equal to the candidate `contentHash` (`evidence_mismatch`).
- `approval` — human approval `{ treeHash, human }` tied to the same `contentHash` (`approval_missing`, `approval_mismatch`).

## Verification sequence (fail closed, before ref mutation)

1. Shape and safety checks: repository, ref, hashes, evidence and approval gates.
2. `git bundle verify` on a 0600 temp copy — a tampered bundle fails its checksum (`invalid_bundle`).
3. `git bundle list-heads` — the bundle must exclusively contain the candidate commit (`bundle_mismatch`).
4. `git bundle unbundle` — adds objects to the object database only; no ref is touched.
5. Object verification against actual bytes: `rev-parse <commit>^{commit}` (`commit_mismatch`), `rev-parse <commit>^{tree}` (`tree_mismatch`), single parent equal to `expectedHead` (`wrong_parent`), then the full committed tree is read back (`ls-tree -r` + `cat-file blob`, rejecting executable/symlink/submodule modes as `unsafe_tree`) and the Confluence content hash of the actual blobs must equal `candidate.contentHash` (`content_mismatch`).
6. Only after all of the above pass: `git update-ref <ref> <new> <expectedHead>` — git's atomic compare-and-swap.

Hooks are explicitly disabled for every command and global/system git config is neutralized via `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM`/`GIT_CONFIG_NOSYSTEM`, matching git-runner. Every raw git command and exit code is appended to `logs/git-publication.jsonl`.

## Concurrency and idempotency

- **Race**: two competing publishers verified against the same `expectedHead` both reach step 6; `update-ref`'s old-value check makes exactly one succeed. The loser gets `stale_head` and the repository is left at the winner's commit.
- **Crash/retry**: if the ref already points at the candidate commit (e.g. the publisher crashed after `update-ref` but before returning), a retry of the *same approved candidate* (all gates re-checked) returns a receipt with `idempotent: true` instead of failing.
- **Stale competitor**: a different candidate prepared from the same base, submitted after another was installed, is rejected with `stale_head` — its `expectedHead` matches neither the current ref nor the idempotent case.

The receipt is `{ ref, head, previousHead, commit, tree, contentHash, idempotent }`.

## Trust and current limits

This function is an internal trusted-runner primitive, not an authenticated API. The calling coordinator must supply evidence and approval from credential-bound persisted state; plain caller-provided strings do not establish authority. Objects are imported before content checks; failed validation may leave unreachable objects but never advances the baseline ref. Only non-executable UTF-8 regular files are supported. Repository hooks are explicitly disabled with core.hooksPath=/dev/null, including reference-transaction hooks.

## Future Artifacts transport (not implemented)

Use the documented smart HTTP Git remote with standard Git clone/fetch/push and a short-lived repo-scoped token. A Git bundle is a local transfer artifact; it is not an HTTP receive-pack request body. The trusted runner should verify imported objects in isolation, then push the candidate ref with an explicit expected old ref, such as git push --force-with-lease=refs/heads/main:<expectedHead>. Actual remote compare-and-swap behavior must be tested. Do not assume a custom server-side lease or merge endpoint exists.

Before push, the Durable Object must reserve the exact approved candidate/base and block conflicting transitions. After push, read the actual remote ref, persist its receipt, then advance coordinator state. A crash between remote push and receipt requires reconciliation, not blind re-push or fabricated success. Repo tokens authorize Git access; application reservations are a separate coordinator mechanism. Until transport and recovery are wired and verified, Worker integration remains 501.

Source: https://developers.cloudflare.com/artifacts/api/git-protocol/ (checked October 4, 2026).
