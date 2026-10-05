# Prototype evidence — October 4, 2026

Eve coordinated two agy discovery roles, two Devin discovery roles, two agy implementation roles and Devin core, platform, independent review and Git runner assignments. Devin used `glm-5-3-flash-max`. One core invocation hit its output limit and was recovered with a narrower assignment. MAOS rejected this model in its dispatch allowlist; direct Devin CLI invocation preserved the requested model.

## Implemented and checked locally

- Persisted objective/task state, checkpoints, patch preconditions and conflict rejection.
- Candidate SHA-256 hash, trusted-runner evidence, human approval and exact-result integration gates.
- Real Git candidate commits in isolated clones, validation against prepared bytes, post-commit byte comparison and retained portable Git bundles.
- Loopback console, serialized HTTP writes, credential-bound Worker identities and separate runner/human roles.
- Static UI exercised through the browser: demo completes, rejection reasons appear, integrated tasks and retained context are visible. Manual task creation also exercised.

Final local suite: **44 tests passed in 6 files, exit 0** (`node node_modules/vitest/vitest.mjs run`). Includes actual temporary Git repositories, bundle restoration, actual HTTP server restart and concurrent writes. Raw output: `logs/tests-final.txt`.

TypeScript: `node node_modules/typescript/bin/tsc --noEmit`, exit 0. Worker dry build: `node node_modules/wrangler/bin/wrangler.js deploy --dry-run`, exit 0; Durable Object and Artifacts bindings included. Generated runtime types are retained in `worker-configuration.d.ts`.

Local workerd HTTP check: ten boundary checks passed plus initial State schema check. Artifacts binding was removed from a temporary local verification config. This is runtime evidence for DO RPC/auth/state routes, **not** evidence of remote Artifacts behavior. Details: `logs/worker-smoke-final.json`.

Independent reviewer identified role-mapping, missing-credential, identity, schema and adapter-error gaps. Coordinator fixes bind identity and role to distinct credentials; reject missing configuration; return initial State; share action envelope; preserve platform faults; wait for pending RPCs before disposing handles. New tests cover credential roles and adapter error/disposal cases. The historical review report describes the pre-fix snapshot; it is not the final verdict.

## Not established

No remote deployment, Artifacts runtime test, remote Git publication or competition submission. Current Cloudflare credentials were rejected. Remote integration returns 501 instead of claiming a DO state update merged a repository.

The demo's agent tasks are deterministic simulations. Local Git creation and fixture validation execute for real. No throughput or massive-concurrency claims; no automatic semantic-merge guarantee. Tests check a bounded JSON fixture contract, not arbitrary software correctness.

## Next work

1. Restore valid Cloudflare authentication and check the real Artifacts adapter.
2. Connect isolated agent repositories to the Git runner; bind trusted execution evidence to remote candidate commits.
3. Add resumable provider execution and baseline compare-and-swap at publication.
4. Measure conflict handling, recovery and concurrency before enlarging the demonstration.
5. Prepare reproducible run instructions and the submission demo; David handles entry.

## Roadmap execution update — October 4, 2026

Account upgrade reported by David. The supplied account API token identifies the intended account and the read-only default-namespace repository listing passed. Inherited token/key/email credentials are excluded unless an explicit private token file is provided; the account ID is explicit. Historical 10004 namespace-list errors do not establish the cause or private-preview status.

Live platform experiment: local workerd/DO with **remote Artifacts binding**, plus actual Cloudflare REST and HTTPS Git operations. Worker adapter created a disposable repo, minted read/write tokens, read exact seeded bytes and commit history, and forked its baseline. Git write-token push passed; read-token push and revoked-token read were rejected (exit 128). Fork file bytes matched. Test-repo tokens were revoked and both created repos received cleanup acceptance; absence confirmation is recorded separately. Evidence: logs/artifacts-live-roundtrip.json, logs/artifacts-live-runtime.txt, logs/artifacts-cleanup-confirmed.json. This does not verify a publicly deployed Worker or end-to-end coordinator publication.

The real development proxy drops custom exception fields for missing repositories. Creation now confirms absence with bounded, paginated namespace listing when that proxy returns an unstructured remote error; a listed repo or failed/incomplete listing prevents creation. A live Worker-created repository passed the round trip after this fix. This is a compatibility workaround, not a claim that missing error codes are part of the platform contract.

Devin (GLM 5.3 Flash Max) built local bare-repository publication with actual-object verification, approval/evidence content binding, atomic ref compare-and-swap and idempotent retry. Coordinator review added explicit hook suppression, special-key filename coverage and rejection of non-UTF-8/executable trees. It is a trusted internal primitive; caller strings are not authentication. Failed candidates may import unreachable Git objects without advancing a baseline ref. Worker integration remains 501 until remote transport/reservations/receipts are wired.

agy delivered the sequential release verifier and draft demo/submission materials. Coordinator corrected unverified preview-cause claims, fake example check/hash values, incomplete transport assumptions and premature submission checkmarks. Provider execution and fresh-clone acceptance remain pending.

Final machine verifier: **60 tests passed in seven files, exit 0**; TypeScript exit 0; Worker dry build exit 0. Raw evidence: logs/verify-release-summary.json and per-step logs. Artifacts unit tests use fakes; Git/server tests execute actual local processes. The first publication integration attempt hit a tmp-directory cleanup assertion in a parallel test; candidate tests were isolated and final results supersede that historical failure.

Private-state HTTP checks: five actual local workerd requests passed (unauthenticated/unknown rejected; human/agent/runner credentials accepted; no-store present). logs/worker-read-smoke.json. Staged-source exact-token/pattern scan found zero matches in 35 staged files; this bounded scan is not a full secret audit. No public repository, public deployment, completed provider demo or contest entry exists yet.

Agent dispatch totals: 8/10 Devin, 5/6 agy. Both roadmap assignments completed; two Devin and one agy remain within the user ceiling. Next machine item: remote Git transport plus coordinator publication reservation and crash reconciliation (MAOS 1068); then actual provider execution (1069).
