# Confluence completion roadmap

Owner: Eve. Updated October 4, 2026, America/Chicago.

## Goal

Give a human a defensible path from one objective through concurrent agent work to one reviewed Git result. Preserve restart context, surface conflicts, and require trusted evidence plus human approval for the exact bytes advanced in Cloudflare Artifacts.

## Machine milestones

1. **Platform access — complete.** The intended Cloudflare account and default Artifacts namespace were verified. Disposable create, seed, fork, read/log, scoped-token, revocation, push rejection, and cleanup checks passed.
2. **Remote publication and recovery — complete.** The runner validates bundle objects and committed bytes, requires matching evidence and approval, pushes with an exact lease, confirms the remote ref, and re-fetches remote bytes for idempotent crash recovery. The Durable Object reserves the candidate/ref/head and advances only after a trusted receipt.
3. **Provider execution and resumption — complete.** Real `agy` and Devin processes ran concurrently in isolated worktrees. Their measured intervals overlapped. A third `agy` task was stopped after 30.337 seconds and resumed successfully in a different OS process with matching checkpoint lineage.
4. **Human review workflow — complete.** The UI shows the objective, task intent, paths, checkpoints, candidate diff/hash, evidence, approval, reservation, publication receipt, baseline, and audit events. Cloud mode separates human, runner, named-agent, and coordinator credentials.
5. **Adversarial evidence — complete for contest scope.** Tests cover stale content, path conflicts, malformed refs/objects, wrong parents, failed/mismatched evidence, unauthorized roles, missing credentials, remote races, failed push, idempotent replay, output bounds, timeouts, interruption, and checkpoint tampering. Claims remain bounded to the tested paths.
6. **Release verification and deployment — complete.** The sequential verifier passes 84 tests in nine files, TypeScript, and Worker dry build. Worker version `98ab4228-0606-4113-bed8-a3a8216748ef` is deployed and its protected state, persistent Artifacts repo, and token mint/revoke route were checked live.
7. **Public source and submission packet — complete.** Source is public at <https://github.com/davidnichols-ops/confluence> with the MIT license, run instructions, evidence, seven-minute demo plan, form copy, deployment inventory, and human checklist.

## Release freeze gates

- Fresh-clone `npm ci` plus `node scripts/verify-release.mjs` must pass from the release commit.
- Tracked-byte credential scan must return no secrets.
- The GitHub repository is public and its `main` ref was read without authentication.
- The deployed Worker must still return the UI, reject unauthenticated state access, and expose the recorded publication to an authorized runner.

## Human-only completion

David must confirm contest eligibility and rights, provide contact/location/attendee details, record or approve the 5–10 minute video, inspect the source and deployment, and personally submit/accept the official terms. The canonical queue is `/Users/david/Desktop/Delegation/cloudflare-confluence-submission.md`.

## Resource record

The architecture/review budget reached the authorized ceilings: 10 Devin and 6 agy assignments, with Devin kept on `glm-5-3-flash-max`. Provider-demo child processes are product execution evidence, not additional architecture assignments.
