# Confluence submission draft — not ready to submit

## Project vision

A human should be able to lead several coding agents toward one useful result without losing their reasoning or accepting a false claim that the result was tested. Confluence records task baselines and checkpoints, surfaces overlapping changes, assembles one candidate and requires trusted validation plus human approval for its content hash.

## How Cloudflare is used

The Worker gateway authenticates roles and identities. A Durable Object persists and serializes coordination state. The Artifacts adapter provides repository inspection, forks, scoped Git tokens and file/history reads. Standard Git prepares and validates candidates in isolated checkouts; portable bundles retain their history.

Current verified local behavior includes exact-content evidence gates, checkpoint retention, conflict/stale rejection and atomic publication to a local bare Git repository. Cloudflare access and live adapter experiments are recorded separately in EVIDENCE.md. The Worker still refuses remote integration until transport and coordinator crash recovery are connected. Automatic provider execution and end-to-end task-repository wiring remain unfinished. Do not paste this draft into the form as a claim of a complete product.

## Reproduction

Install dependencies with npm ci, then run:

```sh
node scripts/verify-release.mjs
node --import tsx src/server.ts
```

Open http://127.0.0.1:8787. The labeled local demo simulates agents but runs actual Git preparation and bounded fixture validation. Raw release logs are in logs/verify-release-*.log. Artifacts unit tests use fakes; local Git/server checks execute real processes. The seven-minute narrative is in docs/DEMO_SCRIPT.md and must be reconciled with the final release before recording.

## Fields David supplies after machine acceptance

Team/contact/location/attendees, final public source URL, approved video and personal confirmation of terms/eligibility. LICENSE is MIT. Verify third-party rights and the clean source inventory before publication. Fresh-clone reproducibility, deployed behavior and the final video are pending.

Sources: [form](https://www.cloudflare.com/git-competition/submit/), [official rules](https://www.cloudflare.com/documents/build-next-gen-git-platform-competition-terms.pdf). Final entry is a human action. See the canonical human checklist in /Users/david/Desktop/Delegation/cloudflare-confluence-submission.md.
