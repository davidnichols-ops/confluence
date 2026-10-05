# Confluence — first working slice

Decision by Eve, October 4, 2026: build objective-based concurrent collaboration with task isolation, persisted context and exact-tree evidence gates. Intent overlap is an advisory signal, never proof of semantic correctness. No claims of massive scale yet.

User journey: create objective → start three concurrent tasks → checkpoint reasoning → propose changes → assemble candidate → test candidate → review → integrate or reject with reason. A replacement agent resumes from persisted task context.

Local prototype runs without credentials. Cloudflare Worker/Durable Object and Artifacts adapter are real code paths, separately labeled unverified until platform execution. Local demo must never imply it used remote Artifacts.

## Ownership, initial implementation wave
- Eve: contracts.ts, package.json, tsconfig.json, local server, overall integration and end-to-end verification.
- Devin core: src/core.ts and tests/core.test.ts only. Pure state machine and meaningful correctness tests.
- Devin platform: src/worker.ts, src/artifacts.ts, wrangler.jsonc and tests/artifacts.test.ts only. Durable Object persistence, Worker routing, Artifacts adapter.
- agy interface: public/index.html only. Polished, dependency-free working UI using the API below. No fake live metrics.
- agy scenario: src/demo.ts and tests/demo.test.ts only. Deterministic concurrent scenario using the core API, with genuine fixture test evaluation; no fake assertions of executed tests.

Read contracts.ts before coding. Never edit another agent's files, install dependencies, publish, commit or spawn agents. Report blockers in your log immediately. Return files, commands and exit codes. Use current MAOS guard; label unavailable checks.

## API shared by local server and Worker
GET /api/state → State
POST /api/actions → { action: Action } → State; invalid operation → JSON {error, code} and HTTP 400/409.
POST /api/demo → State after deterministic demo (local server only initially; Worker can explicitly return 501).
API mutations require Authorization Bearer token when configured; local binds only 127.0.0.1.

Core exports createState(files?), applyAction(state, action): Promise<State>, treeHash(files): Promise<string>, DomainError with code. Input state must not be mutated. IDs unique, timestamps injectable through action fields if needed. Web Crypto SHA-256 stable canonical file map.

Core state records baseline file tree and revision, tasks with baseRevision and baseFiles, patches and context, immutable event sequence, candidate tree with taskIds, evidence and human approval tied to exact tree hash. No LLM output or agent-submitted pass=true establishes trusted evidence.

Commands: create_objective, create_task, checkpoint, propose, assemble, record_evidence, approve, integrate.
create_task captures baseline; propose compares patch before contents to base files; assemble applies patches to current baseline with precondition checks, rejects stale bases and path conflicts conservatively; any change invalidates prior candidate/evidence/approval. record_evidence must match candidate hash and be sent only by trusted runner in server; approve only by trusted human server context; integrate requires passing evidence and approval matching candidate hash AND current baseline revision, then advances baseline and marks tasks integrated.

Server authority injection: action includes actor {id, role:'agent'|'runner'|'human'}; server overwrites externally supplied roles so API clients cannot impersonate runner. UI approval is human-local demo action, document cloud authentication requirement. Evidence runner executes fixture validator and binds its actual result to candidate tree hash. Core still enforces role.

UI focus: one objective, clear mode badge, concurrent task lanes, preserved context, candidate diff, evidence status and rejected-action timeline. Demo buttons should explain workflow. No chart implying unmeasured performance.

Fixture: TypeScript-shaped key-value source text or JSON file tree. Three task changes include at least two useful disjoint changes and one overlapping/stale proposal. Validate composed fixture behavior with a deterministic test harness in demo.ts. Show rejected stale evidence; resume context; successful approved integration. Simulation clearly labeled, backend/state machine real.

Cloudflare Artifacts: use documented env.ARTIFACTS namespace, create/get/fork/info/createToken; dispose RPC handles. No inventing merge API. Server-side Git merge is not available in binding: document integration boundary honestly, fail closed instead of claiming remote merge. Worker coordinator provides persisted state and token-gated endpoints, with mandatory authentication on writes. Never log repository tokens.
