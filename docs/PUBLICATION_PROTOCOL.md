# Git publication protocol

Status: implemented for local bare Git repositories and Cloudflare Artifacts smart HTTP; both paths use actual Git object verification and compare-and-swap semantics.

## Admission contract

The publisher receives a prepared candidate `{ commit, tree, contentHash }`, a portable bundle, a safe `refs/heads/*` target, an expected old head, passing trusted-runner evidence, and human approval. Evidence and approval must name the same content hash. Remote credentials are passed separately and never embedded in the receipt or command log.

## Verification before mutation

1. Validate ref, object IDs, content hash, timeout, remote, evidence, and approval.
2. Write the bundle to a mode-0600 temporary file and run `git bundle verify` and `git bundle list-heads`.
3. Unbundle only into an isolated bare verification repository.
4. Resolve the claimed commit and tree from actual objects; require the expected parent (or a root commit for a zero head).
5. Reconstruct every committed file with `ls-tree` and `cat-file`. Accept only non-executable UTF-8 regular files and recompute the Confluence content hash.
6. Query the actual remote ref. Reject a missing/unexpected head unless this is an exact idempotent replay.
7. Push with `--force-with-lease=<ref>:<expectedHead>` and confirm `ls-remote` advertises the candidate commit.

Global/system Git configuration, prompts, credential helpers, and hooks are disabled. The bearer token is supplied through an `http.extraHeader`; logs use a redacted command label.

## Coordinator transaction

The human first reserves the approved candidate, target ref, and expected remote head in the Durable Object. This does not advance the baseline. A trusted runner publishes and sends a receipt containing the ref, previous head, commit, Git tree, content hash, credential-free HTTPS remote, and timestamp. The coordinator accepts only a receipt matching the reservation, then updates the baseline and marks the tasks integrated.

If a crash occurs after push and before receipt, retry sees the candidate already advertised, fetches it, re-verifies commit/tree/files/content hash, and returns an idempotent receipt. A competing candidate receives `stale_head`; it cannot overwrite the winner.

Repository creation/fork bootstrap tokens are revoked immediately. Explicitly minted tokens can be revoked through `/api/artifacts/token/revoke`; successful smoke scripts do so before exit.

## Deliberate limits

The trusted runner is an authenticated internal boundary. Importing a rejected bundle can leave unreachable objects in its temporary repository, never an advanced ref. The prototype handles text files only. Direct Artifacts binding “merge” remains unavailable because publication uses standard Git smart HTTP.

Cloudflare reference: <https://developers.cloudflare.com/artifacts/api/git-protocol/>.
