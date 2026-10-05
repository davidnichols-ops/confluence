# Confluence seven-minute demo

Target length: 6:30–7:30. Record the deployed UI, terminal evidence, and the Cloudflare dashboard/Artifacts repository without exposing bearer tokens.

## 0:00–0:45 — The failure

“Several coding agents can work at once, but concurrency creates a harder problem: which context survives interruption, which changes conflict, and did we test the exact bytes we published? Confluence makes those claims reviewable.”

Show the three lanes: objective/tasks, candidate pipeline, and audit events.

## 0:45–1:35 — Architecture

Show this compact flow:

```text
human / agents / trusted runner
              │ scoped bearer roles
              ▼
Cloudflare Worker ── Durable Object coordinator
              │
              └──── Cloudflare Artifacts Git baseline
```

Explain that the Durable Object serializes intent and review state while Artifacts owns Git history. The runner publishes only after evidence and approval match the candidate content hash.

## 1:35–2:30 — Concurrent real agents

Run or replay `scripts/provider-demo.mjs` evidence. Show the two provider intervals: `agy` and Devin started four milliseconds apart and each made a real commit in a separate worktree. Point out explicit argv, cwd allowlists, time/output caps, and SHA-256 stream digests.

Do not claim massive scale. Say: “This run proves two-provider overlap.”

## 2:30–3:15 — Interruption recovery

Show the `agy-roman` checkpoint: interrupted after 30.337 seconds with partial output digests. Then show attempt 2, matching `resumeOf`, a different OS process ID, completed status, and the final commit.

Mention the honest blemish: Devin left uncommitted workspace metadata, which stayed isolated and is recorded as `clean: false`.

## 3:15–4:25 — Exact-candidate review

Use the local scenario or an authenticated deployed state:

1. Show task intent, paths, and preserved checkpoint context.
2. Assemble proposed tasks; show a same-file conflict being rejected.
3. Open the candidate diff and exact content hash.
4. Show trusted evidence and human approval naming that hash.
5. Reserve the current Artifacts head for publication.

Explain that a new proposal invalidates prior evidence/approval.

## 4:25–5:35 — Remote publication and crash window

Show the publication receipt for commit `52b1edaba237676bacd69c73e072bc8a001d08fb` and the persistent `confluence-baseline` repository.

Narrate the runner sequence: bundle verify, actual commit/tree/parent inspection, reconstruct committed bytes, compare content hash, `push --force-with-lease`, then `ls-remote` confirmation. Explain that retry fetches and re-verifies an already-published commit before returning an idempotent receipt.

## 5:35–6:20 — Security and adversarial cases

Show unauthenticated `/api/state` returning 401 and a short-lived token being revoked. Summarize tested rejection paths: stale head, wrong parent, malformed ref, evidence mismatch, unauthorized role, competing publisher, timeout, and tampered checkpoint.

## 6:20–7:00 — Reproducibility and close

Run `node scripts/verify-release.mjs` and show:

- 84 tests in nine files pass.
- TypeScript passes.
- Worker dry build passes with Durable Object and Artifacts bindings.

Close with: “Confluence does not ask you to trust an agent consensus. It preserves why agents acted, shows what changed, and proves which reviewed bytes reached Git.”

## Recording checklist

- Hide terminal environment variables, token files, request headers, account billing, and unrelated browser tabs.
- Show the deployed URL and public source revision.
- Keep the evidence JSON available as a cutaway, but favor readable UI states.
- Export MP4, WebM, or MOV under 2 GiB and review it once signed out.
