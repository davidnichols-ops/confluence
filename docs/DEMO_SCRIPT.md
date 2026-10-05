# Confluence: 7-Minute Demonstration Script

**Competition:** Cloudflare Build the Next-Gen Git Platform Competition
**Target Duration:** 7 minutes (0:00 – 7:00)
**Presenter Role:** Human Lead / Technical Architect
**Project Goal:** Turn one shared objective into concurrent, reviewable changes with preserved context and evidence tied to the exact integrated result.

---

## Reality Boundary & Status Key

To maintain strict scientific and technical honesty, every phase in this demonstration is labeled with its exact implementation status:

- `[CURRENTLY WORKS LOCALLY]`: Fully implemented and empirically verified in this repository. Runs without cloud credentials via the local loopback server (`http://127.0.0.1:8787`), pure state engine, Git candidate builder, and browser interface.
- `[VERIFIED WORKER DRY-BUILD]`: Cloudflare Worker code (`src/worker.ts`), Durable Object bindings, and Artifacts bindings compile cleanly and pass static bundle dry-run checks via `wrangler deploy --dry-run`.
- `[PENDING FUTURE CLOUDFLARE/PROVIDER WORK]`: Some adapters exist; end-to-end remote integration and provider orchestration are not implemented. Cloudflare account access has been restored. Historical namespace listing returned Access denied 10004; live binding checks are recorded separately in EVIDENCE.md. Live Artifacts adapter checks passed; end-to-end integration and multi-LLM worker loops remain future work.
- `[ZERO INVENTED METRICS]`: No unmeasured TPS, throughput, or hypothetical scale claims are made. All outputs reflect genuine test runs and local Git bundles.

---

## Demonstration Breakdown

### 0:00 – 1:00 | Minute 1: The Multi-Agent Collaboration Dilemma

- **Visual:** Terminal launching the local development server:
  ```sh
  npm run dev
  ```
  Browser opens to `http://127.0.0.1:8787`. UI shows a clean, dependency-free dashboard: Objective banner, Concurrent Task lanes, Candidate Tree viewer, Evidence Gate status, and an Event Audit log.
- **Presenter Narrative:**
  > "Today, coding agents either work in isolated single-threaded silos or step on each other's toes in uncoordinated chat rooms. When multiple agents tackle a large objective concurrently, three critical failures happen:
  > 1. **Context Evaporation:** When an agent crashes or hits context limits, its internal reasoning is lost, forcing replacement agents to start from scratch.
  > 2. **Silent Overwrites & Race Conditions:** Agents propose overlapping changes against obsolete baselines.
  > 3. **Hallucinated Verification:** Agents self-certify that their own code passes tests without independent proof.
  >
  > Confluence is being built to address this using Cloudflare Workers for serialized edge coordination and Cloudflare Artifacts for isolated Git repository forks. Let's see how this works in practice."
- **Status:** `[CURRENTLY WORKS LOCALLY]` (Local server and static UI running on loopback).

---

### 1:00 – 2:15 | Minute 2: Objective Creation & Task Context Checkpointing

- **Visual:** In the UI, the presenter enters a new shared objective:
  `"Enable metrics telemetry and caching concurrently with isolated verification"`
  Three concurrent task lanes appear on screen:
  1. **Task 1 (`agent-telemetry`)**: Updates `config/service.json` to enable caching and metrics flags, increasing rate limits.
  2. **Task 2 (`agent-routes`)**: Updates `config/routes.json` to register the new `/api/metrics` scraping endpoint.
  3. **Task 3 (`agent-conflicting`)**: Competing task that independently reconfigures `config/service.json` to an incompatible port (9090).
- **Action:** Presenter clicks into **Task 1** and **Task 2** to inspect the checkpointed context.
- **Presenter Narrative:**
  > "Notice that as each task executes, it commits structured checkpoint records into Confluence: a summary, the next planned step, and operational notes.
  > If `agent-telemetry` (modeled as a GLM 5.3 Flash Max instance) were interrupted right now, a fresh agent can immediately pick up this exact state without re-parsing whole conversation transcripts.
  > Each task is bound to baseline revision 0 and captures its initial file snapshot."
- **Status:** `[CURRENTLY WORKS LOCALLY]` (State machine enforces immutable checkpoints and baseline tracking in `.local/state.json`).

---

### 2:15 – 3:30 | Minute 3: Proposed Patches & Conservative Conflict Rejection

- **Visual:** All three tasks advance to the `proposed` state with before/after patch definitions.
- **Action:** Presenter clicks **"Assemble Candidate (Tasks 1 & 3)"** to simulate an invalid merge attempt.
- **UI Feedback:** Red banner appears with an explicit domain error:
  `DomainError: path_conflict: Both tasks modify config/service.json`
- **Presenter Narrative:**
  > "Confluence is intentionally conservative. Task 1 and Task 3 both attempt to modify `config/service.json`. Instead of blindly guessing semantics or letting an LLM hallucinate an arbitrary merge, Confluence detects the path conflict immediately and rejects candidate assembly.
  > Now let's assemble the two disjoint, compatible tasks: Task 1 and Task 2."
- **Action:** Presenter clicks **"Assemble Candidate (Tasks 1 & 2)"**.
- **UI Feedback:** Assembly succeeds! The UI displays:
  - Candidate Base Revision: `0`
  - Candidate Files: Composed tree containing both `config/service.json` and `config/routes.json`.
  - Canonical SHA-256 Tree Hash: e.g., `8f7b...`
  - Status: *Awaiting Trusted Evidence*.
- **Status:** `[CURRENTLY WORKS LOCALLY]` (Deterministic patch application and path conflict detection in `src/core.ts`).

---

### 3:30 – 4:45 | Minute 4: The Trusted Runner & Evidence Gates

- **Visual:** Candidate panel showing the SHA-256 tree hash and the Evidence Gate.
- **Action:** Presenter attempts three unauthorized or invalid actions to demonstrate the security perimeter:
  1. *Agent Self-Certification:* An agent attempts to send `record_evidence` (`role: 'agent'`).
     - **Result:** Rejected with `DomainError: unauthorized` (only `runner` role permitted).
  2. *Mismatched Evidence:* A runner submits test evidence for an outdated/different tree hash.
     - **Result:** Rejected with `DomainError: candidate_hash_mismatch`.
  3. *Unapproved Integration:* Attempting to integrate before human sign-off.
     - **Result:** Rejected with `DomainError: unapproved`.
- **Action:** The genuine local fixture runner executes:
  ```sh
  node node_modules/vitest/vitest.mjs run tests/demo.test.ts
  ```
  The runner validates the JSON syntax and semantic schema of the exact candidate tree, verifies all required routes, and posts trusted evidence with `passed: true`.
- **UI Feedback:** Evidence Gate turns green: `Read the actual runner, check count and full hash from the current UI; do not use example values`
- **Presenter Narrative:**
  > "No amount of LLM self-confidence counts as evidence. The evidence gate requires an independent trusted runner executing against the exact candidate byte-tree. The evidence is cryptographically bound to the candidate's canonical SHA-256 hash."
- **Status:** `[CURRENTLY WORKS LOCALLY]` (Deterministic runner and core role-based gate verification).

---

### 4:45 – 5:45 | Minute 5: Human Review, Integration & Git Bundle Preservation

- **Visual:** The Human Review modal displays the candidate diff and all passing runner checks.
- **Action:** Presenter clicks **"Approve Candidate"** then **"Integrate Candidate"**.
- **UI Feedback:**
  - Baseline advances: `Revision 0 -> Revision 1`.
  - Task Status: Task 1 and Task 2 are marked `integrated`.
  - Task 3 remains `proposed` with its checkpoint preserved, ready for an explicit rebase against Revision 1.
- **Visual (Terminal):** Presenter inspects the filesystem:
  ```sh
  ls -lh .local/candidates/
  git clone .local/candidates/<candidate-hash>.bundle restored-candidate
  git -C restored-candidate log -1 --stat
  ```
- **Presenter Narrative:**
  > "Behind the scenes, Confluence created an isolated Git repository clone, committed the candidate files, verified post-commit bytes against the tree hash, and exported a standalone Git bundle to `.local/candidates/`.
  > You can clone this `.bundle` directly with native Git anywhere in the world. The integrated candidate is a real Git commit."
- **Status:** `[CURRENTLY WORKS LOCALLY]` (Isolated Git cloning, tree validation, and portable bundle generation via `src/git-runner.ts`).

---

### 5:45 – 7:00 | Minute 6 & 7: Cloudflare Edge Architecture & Honest Roadmap

- **Visual:** Architecture slide showing Cloudflare Workers (`Coordinator` Durable Object) + Cloudflare Artifacts integration:
  ```
  [ Human / Agents ]
         │ (HTTP Bearer Token)
         ▼
  [ Cloudflare Worker Gateway ]
         │
         ├─── Coordinator (Durable Object: SQLite, Serialized State, Token Auth)
         │
         └─── Artifacts Adapter (env.ARTIFACTS: createRepo, forkRepo, createToken)
  ```
- **Presenter Narrative:**
  > "How does this scale to the cloud?
  > 1. **Cloudflare Worker & Coordinator Durable Object:** `src/worker.ts` implements the coordination API at the edge. The `Coordinator` Durable Object enforces single-writer serialized transitions, verifies credentials (`HUMAN_TOKEN`, `RUNNER_TOKEN`, `AGENT_TOKENS`), and provides durable persistence.
  > 2. **Cloudflare Artifacts Binding:** `src/artifacts.ts` provides repository fork and scoped token operations; automatic task-repository and provider orchestration still require wiring.
  > 3. **Static Dry-Run Build Verified:** The Worker compiles and passes `wrangler deploy --dry-run` with both Durable Object and Artifacts bindings intact.
  >
  > **What is Pending Future Work:**
  > We believe in complete transparency:
  > - Account access is restored; we are verifying live Artifacts behavior. See EVIDENCE.md for the current result.
  > - Because of this, live remote repository creation and live Git receive-pack integration remain unverified on production edge servers. The Worker integration endpoint explicitly returns HTTP 501 rather than claiming a Durable Object state update merged a remote Git repo.
  > - Future milestones will wire live Artifacts Git transport, atomic compare-and-swap refs, and resumable LLM execution loops using GLM 5.3 Flash Max.
  >
  > Everything demonstrated today can be verified in 6 seconds with our built-in release verifier:
  > `node scripts/verify-release.mjs`
  > Thank you."
- **Status:** `[VERIFIED WORKER DRY-BUILD]` for Worker code; `[PENDING FUTURE CLOUDFLARE/PROVIDER WORK]` for remote Artifacts API.

---

## Technical Summary of Demo Checkpoints

| Checkpoint | Action | Expected Result | Status |
| :--- | :--- | :--- | :--- |
| **01. Baseline Creation** | POST `/api/actions` (`create_objective`) | Objective set, baseline revision 0 created | `CURRENTLY WORKS LOCALLY` |
| **02. Task Registration** | POST `/api/actions` (`create_task`) | 3 tasks registered with base revision 0 | `CURRENTLY WORKS LOCALLY` |
| **03. Context Checkpoint** | POST `/api/actions` (`checkpoint`) | Structured reasoning saved in task context | `CURRENTLY WORKS LOCALLY` |
| **04. Conflict Detection** | POST `/api/actions` (`assemble` tasks 1 & 3) | Rejected with `path_conflict` | `CURRENTLY WORKS LOCALLY` |
| **05. Disjoint Assembly** | POST `/api/actions` (`assemble` tasks 1 & 2) | Candidate tree formed, SHA-256 tree hash generated | `CURRENTLY WORKS LOCALLY` |
| **06. Agent Self-Certify** | POST `/api/actions` (`record_evidence` by agent) | Rejected with `unauthorized` role error | `CURRENTLY WORKS LOCALLY` |
| **07. Hash Mismatch** | POST `/api/actions` (`record_evidence` wrong hash) | Rejected with `candidate_hash_mismatch` | `CURRENTLY WORKS LOCALLY` |
| **08. Runner Validation** | Deterministic fixture validation | Actual JSON syntax/schema checks evaluated | `CURRENTLY WORKS LOCALLY` |
| **09. Trusted Evidence** | POST `/api/actions` (`record_evidence` by runner) | Evidence accepted and bound to tree hash | `CURRENTLY WORKS LOCALLY` |
| **10. Human Review Gate** | POST `/api/actions` (`approve` by human) | Approval recorded for exact candidate tree hash | `CURRENTLY WORKS LOCALLY` |
| **11. Atomic Integration** | POST `/api/actions` (`integrate` by human) | Baseline advances to rev 1, tasks 1 & 2 integrated | `CURRENTLY WORKS LOCALLY` |
| **12. Git Bundle Export** | Isolated Git clone & commit | Portable `.bundle` saved in `.local/candidates/` | `CURRENTLY WORKS LOCALLY` |
| **13. Worker Compilation**| `wrangler deploy --dry-run` | Zero TypeScript/bundle errors, DO/Artifacts bound | `VERIFIED WORKER DRY-BUILD` |
| **14. Remote Artifacts** | Call `env.ARTIFACTS` on Cloudflare | Live binding/Git experiment passed; integration/provider wiring pending | `PENDING FUTURE WORK` |
