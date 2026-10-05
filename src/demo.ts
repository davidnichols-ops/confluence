import { createState, applyAction, DomainError } from './core.js';
import type { Action, Files, State } from './contracts.js';

export const fixtureFiles: Files = {
  'config/service.json': JSON.stringify(
    {
      name: 'confluence-service',
      version: '1.0.0',
      port: 8787,
      rateLimit: 100,
      cors: ['http://localhost:8787', 'http://127.0.0.1:8787'],
      features: {
        caching: false,
        metrics: false,
        tracing: false,
      },
    },
    null,
    2
  ),
  'config/routes.json': JSON.stringify(
    {
      routes: [
        { path: '/api/health', method: 'GET', enabled: true },
        { path: '/api/state', method: 'GET', enabled: true },
      ],
    },
    null,
    2
  ),
};

export function validateCandidate(files: Files): { passed: boolean; checks: string[] } {
  const checks: string[] = [];
  let passed = true;

  // 1. JSON parsing check for all files in candidate
  for (const [path, content] of Object.entries(files)) {
    if (typeof content !== 'string') {
      checks.push(`FAIL: ${path} content is not a string`);
      passed = false;
      continue;
    }
    if (path.endsWith('.json')) {
      try {
        JSON.parse(content);
        checks.push(`PASS: ${path} is valid JSON`);
      } catch (err) {
        checks.push(`FAIL: ${path} has invalid JSON syntax: ${(err as Error).message}`);
        passed = false;
      }
    }
  }

  // 2. Required config/service.json existence
  if (!('config/service.json' in files)) {
    checks.push('FAIL: Required file config/service.json is missing');
    return { passed: false, checks };
  }

  // 3. Required config/routes.json existence
  if (!('config/routes.json' in files)) {
    checks.push('FAIL: Required file config/routes.json is missing');
    return { passed: false, checks };
  }

  // 4. Schema checks on config/service.json
  try {
    const service = JSON.parse(files['config/service.json']);
    if (!service || typeof service !== 'object' || Array.isArray(service)) {
      checks.push('FAIL: config/service.json root must be a JSON object');
      passed = false;
    } else {
      // name
      if (typeof service.name !== 'string' || service.name.trim().length === 0) {
        checks.push('FAIL: config/service.json: "name" must be a non-empty string');
        passed = false;
      } else {
        checks.push(`PASS: config/service.json: service name "${service.name}"`);
      }

      // version semver
      if (typeof service.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(service.version)) {
        checks.push('FAIL: config/service.json: "version" must follow semver format (X.Y.Z)');
        passed = false;
      } else {
        checks.push(`PASS: config/service.json: semver version "${service.version}"`);
      }

      // port
      if (typeof service.port !== 'number' || !Number.isInteger(service.port) || service.port < 1024 || service.port > 65535) {
        checks.push('FAIL: config/service.json: "port" must be integer between 1024 and 65535');
        passed = false;
      } else {
        checks.push(`PASS: config/service.json: port ${service.port} in valid range`);
      }

      // rateLimit
      if (typeof service.rateLimit !== 'number' || service.rateLimit < 10) {
        checks.push('FAIL: config/service.json: "rateLimit" must be number >= 10');
        passed = false;
      } else {
        checks.push(`PASS: config/service.json: rateLimit ${service.rateLimit}`);
      }

      // cors
      if (
        !Array.isArray(service.cors) ||
        service.cors.length === 0 ||
        !service.cors.every((o: unknown) => typeof o === 'string' && (o.startsWith('http://') || o.startsWith('https://')))
      ) {
        checks.push('FAIL: config/service.json: "cors" must be non-empty array of valid HTTP/HTTPS origins');
        passed = false;
      } else {
        checks.push(`PASS: config/service.json: ${service.cors.length} CORS origins valid`);
      }

      // features
      if (!service.features || typeof service.features !== 'object' || Array.isArray(service.features)) {
        checks.push('FAIL: config/service.json: "features" must be an object');
        passed = false;
      } else {
        for (const [feat, val] of Object.entries(service.features)) {
          if (typeof val !== 'boolean') {
            checks.push(`FAIL: config/service.json: feature "${feat}" must be a boolean`);
            passed = false;
          }
        }
        checks.push('PASS: config/service.json: feature flags structure valid');
      }

      // 5. Schema and semantic checks on config/routes.json
      const routesDoc = JSON.parse(files['config/routes.json']);
      if (!routesDoc || !Array.isArray(routesDoc.routes)) {
        checks.push('FAIL: config/routes.json: "routes" must be an array');
        passed = false;
      } else {
        const seenPaths = new Set<string>();
        let routesValid = true;
        for (const r of routesDoc.routes) {
          if (!r || typeof r !== 'object') {
            checks.push('FAIL: config/routes.json: route entry must be an object');
            routesValid = false;
            continue;
          }
          if (typeof r.path !== 'string' || !r.path.startsWith('/')) {
            checks.push(`FAIL: config/routes.json: route path "${r.path}" must start with "/"`);
            routesValid = false;
          }
          if (!['GET', 'POST', 'PUT', 'DELETE', 'PATCH'].includes(r.method)) {
            checks.push(`FAIL: config/routes.json: route method "${r.method}" invalid`);
            routesValid = false;
          }
          if (typeof r.enabled !== 'boolean') {
            checks.push('FAIL: config/routes.json: route "enabled" must be boolean');
            routesValid = false;
          }
          if (seenPaths.has(r.path)) {
            checks.push(`FAIL: config/routes.json: duplicate route path "${r.path}"`);
            routesValid = false;
          }
          seenPaths.add(r.path);
        }
        if (routesValid) {
          checks.push(`PASS: config/routes.json: ${routesDoc.routes.length} route definitions valid`);
        } else {
          passed = false;
        }

        // Semantic cross-file rule 1: If features.metrics is enabled, /api/metrics route must exist and be enabled
        if (service.features?.metrics === true) {
          const hasMetrics = routesDoc.routes.some((r: { path: string; enabled: boolean }) => r.path === '/api/metrics' && r.enabled);
          if (!hasMetrics) {
            checks.push('FAIL: Semantic consistency: features.metrics is enabled but /api/metrics route is missing or disabled');
            passed = false;
          } else {
            checks.push('PASS: Semantic consistency: features.metrics satisfied by enabled /api/metrics route');
          }
        }

        // Semantic cross-file rule 2: If features.caching is enabled, rateLimit must be at least 50
        if (service.features?.caching === true && service.rateLimit < 50) {
          checks.push('FAIL: Semantic consistency: features.caching requires rateLimit >= 50');
          passed = false;
        } else if (service.features?.caching === true) {
          checks.push('PASS: Semantic consistency: caching supported by rateLimit >= 50');
        }
      }
    }
  } catch (err) {
    checks.push(`FAIL: Validation error: ${(err as Error).message}`);
    passed = false;
  }

  return { passed, checks };
}

export async function runDemo(validate = async (_baseline: Files, files: Files) => validateCandidate(files)): Promise<{
  state: State;
  outcomes: { label: string; accepted: boolean; reason: string }[];
}> {
  const outcomes: { label: string; accepted: boolean; reason: string }[] = [];

  let state = createState(fixtureFiles);

  // Helper to apply an action expecting success
  async function execExpected(action: Action, label: string, successReason: string): Promise<void> {
    try {
      state = await applyAction(state, action);
      outcomes.push({ label, accepted: true, reason: successReason });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      outcomes.push({ label, accepted: false, reason: `Unexpected error: ${msg}` });
      throw err;
    }
  }

  // Helper to apply an action expecting rejection
  async function execRejected(action: Action, label: string): Promise<void> {
    try {
      state = await applyAction(state, action);
      outcomes.push({ label, accepted: true, reason: 'Action was unexpectedly accepted' });
    } catch (err) {
      const reason = err instanceof DomainError ? `[${err.code}] ${err.message}` : (err as Error).message;
      outcomes.push({ label, accepted: false, reason });
    }
  }

  // 1. Establish objective
  await execExpected(
    {
      type: 'create_objective',
      objective: 'Enable metrics telemetry and caching concurrently with isolated verification',
      actor: { id: 'human-lead', role: 'human' },
    },
    'Establish objective',
    'Objective established for concurrent feature and route isolation'
  );

  // 2. Create three tasks against baseline revision 0
  // Task 1: Disjoint change 1 - Service configuration (features: caching & metrics, rateLimit: 200)
  await execExpected(
    {
      type: 'create_task',
      id: 'task-telemetry-config',
      title: 'Enable metrics & caching feature flags',
      agent: 'agent-telemetry',
      intent: 'Enable metrics and caching feature flags in config/service.json with rateLimit 200',
      paths: ['config/service.json'],
      actor: { id: 'agent-telemetry', role: 'agent' },
    },
    'Create task 1 (service features)',
    'Task 1 registered against baseline revision 0 for config/service.json'
  );

  // Task 2: Disjoint change 2 - Route definition (add /api/metrics)
  await execExpected(
    {
      type: 'create_task',
      id: 'task-metrics-route',
      title: 'Add /api/metrics telemetry route',
      agent: 'agent-routes',
      intent: 'Register GET /api/metrics route in config/routes.json',
      paths: ['config/routes.json'],
      actor: { id: 'agent-routes', role: 'agent' },
    },
    'Create task 2 (metrics route)',
    'Task 2 registered against baseline revision 0 for config/routes.json'
  );

  // Task 3: Overlapping/conflicting task - also modifies config/service.json with conflicting port
  await execExpected(
    {
      type: 'create_task',
      id: 'task-conflicting-config',
      title: 'Conflicting port service reconfiguration',
      agent: 'agent-conflicting',
      intent: 'Directly modify config/service.json with conflicting port 9090',
      paths: ['config/service.json'],
      actor: { id: 'agent-conflicting', role: 'agent' },
    },
    'Create task 3 (conflicting service config)',
    'Task 3 registered against baseline revision 0 for config/service.json'
  );

  // 3. Preserve checkpoint context across tasks
  await execExpected(
    {
      type: 'checkpoint',
      taskId: 'task-telemetry-config',
      context: {
        summary: 'Configured service features: enabled caching and metrics telemetry, set rateLimit to 200.',
        nextStep: 'Assemble candidate together with route-agent route addition.',
        notes: ['RateLimit increased to 200 to accommodate caching', 'Metrics flag set to true'],
      },
      actor: { id: 'agent-telemetry', role: 'agent' },
    },
    'Checkpoint task 1 context',
    'Preserved telemetry reasoning and next steps in task context'
  );

  await execExpected(
    {
      type: 'checkpoint',
      taskId: 'task-metrics-route',
      context: {
        summary: 'Defined /api/metrics route for Prometheus scrape endpoint.',
        nextStep: 'Coordinate joint candidate assembly with telemetry-agent.',
        notes: ['Route method GET, enabled: true', 'Complements telemetry-agent feature flag'],
      },
      actor: { id: 'agent-routes', role: 'agent' },
    },
    'Checkpoint task 2 context',
    'Preserved route registration reasoning and next steps in task context'
  );

  await execExpected(
    {
      type: 'checkpoint',
      taskId: 'task-conflicting-config',
      context: {
        summary: 'Reconfigured service config independently with conflicting port 9090.',
        nextStep: 'Rebase onto latest revision when baseline advances.',
        notes: ['Touches config/service.json directly', 'Direct path conflict with task 1'],
      },
      actor: { id: 'agent-conflicting', role: 'agent' },
    },
    'Checkpoint task 3 context',
    'Preserved conflicting task reasoning and next steps in task context'
  );

  // 4. Propose patches for each task
  const servicePatchedContent = JSON.stringify(
    {
      name: 'confluence-service',
      version: '1.0.0',
      port: 8787,
      rateLimit: 200,
      cors: ['http://localhost:8787', 'http://127.0.0.1:8787'],
      features: {
        caching: true,
        metrics: true,
        tracing: false,
      },
    },
    null,
    2
  );

  await execExpected(
    {
      type: 'propose',
      taskId: 'task-telemetry-config',
      patches: [
        {
          path: 'config/service.json',
          before: fixtureFiles['config/service.json'],
          after: servicePatchedContent,
        },
      ],
      actor: { id: 'agent-telemetry', role: 'agent' },
    },
    'Propose task 1 patches',
    'Proposed feature flag changes matching base files'
  );

  const routesPatchedContent = JSON.stringify(
    {
      routes: [
        { path: '/api/health', method: 'GET', enabled: true },
        { path: '/api/state', method: 'GET', enabled: true },
        { path: '/api/metrics', method: 'GET', enabled: true },
      ],
    },
    null,
    2
  );

  await execExpected(
    {
      type: 'propose',
      taskId: 'task-metrics-route',
      patches: [
        {
          path: 'config/routes.json',
          before: fixtureFiles['config/routes.json'],
          after: routesPatchedContent,
        },
      ],
      actor: { id: 'agent-routes', role: 'agent' },
    },
    'Propose task 2 patches',
    'Proposed route additions matching base files'
  );

  const conflictingPatchedContent = JSON.stringify(
    {
      name: 'confluence-service',
      version: '1.0.0',
      port: 9090,
      rateLimit: 50,
      cors: ['http://localhost:8787'],
      features: {
        caching: false,
        metrics: false,
        tracing: false,
      },
    },
    null,
    2
  );

  await execExpected(
    {
      type: 'propose',
      taskId: 'task-conflicting-config',
      patches: [
        {
          path: 'config/service.json',
          before: fixtureFiles['config/service.json'],
          after: conflictingPatchedContent,
        },
      ],
      actor: { id: 'agent-conflicting', role: 'agent' },
    },
    'Propose task 3 patches',
    'Proposed conflicting service patch'
  );

  // 5. REJECTED OUTCOME 1: Conflict rejection
  // Attempt to assemble Task 1 and Task 3 together (both touch config/service.json)
  await execRejected(
    {
      type: 'assemble',
      taskIds: ['task-telemetry-config', 'task-conflicting-config'],
      actor: { id: 'human-lead', role: 'human' },
    },
    'Reject conflicting task assembly'
  );

  // 6. Assemble valid disjoint candidate (Task 1 & Task 2)
  await execExpected(
    {
      type: 'assemble',
      taskIds: ['task-telemetry-config', 'task-metrics-route'],
      actor: { id: 'human-lead', role: 'human' },
    },
    'Assemble disjoint tasks (1 & 2)',
    'Candidate tree assembled from the two disjoint task proposals'
  );

  const candidateHash = state.candidate?.treeHash ?? '';

  // 7. REJECTED OUTCOME 2: Agent-forged evidence rejection
  // An agent attempts to self-certify evidence
  await execRejected(
    {
      type: 'record_evidence',
      evidence: {
        treeHash: candidateHash,
        passed: true,
        checks: ['Agent claimed all tests passed without running trusted harness'],
      },
      actor: { id: 'agent-telemetry', role: 'agent' },
    },
    'Reject agent-forged evidence'
  );

  // 8. REJECTED OUTCOME 3: Stale / mismatched evidence rejection
  // A runner submits evidence for a stale / non-matching tree hash
  await execRejected(
    {
      type: 'record_evidence',
      evidence: {
        treeHash: '0000000000000000000000000000000000000000000000000000000000000000',
        passed: true,
        checks: ['Evidence computed against obsolete candidate revision'],
      },
      actor: { id: 'trusted-runner', role: 'runner' },
    },
    'Reject stale/mismatched evidence'
  );

  // 9. REJECTED OUTCOME 4: Integrate without human approval rejection
  await execRejected(
    {
      type: 'integrate',
      actor: { id: 'human-lead', role: 'human' },
    },
    'Reject unapproved integration'
  );

  // 10. Genuine trusted deterministic validation of candidate files
  const validation = await validate(state.baseline, state.candidate!.files);
  if (!validation.passed) {
    throw new Error(`Candidate validation failed unexpectedly: ${validation.checks.join('; ')}`);
  }

  // Record trusted runner evidence
  await execExpected(
    {
      type: 'record_evidence',
      evidence: {
        treeHash: candidateHash,
        passed: validation.passed,
        checks: validation.checks,
      },
      actor: { id: 'local-fixture-runner', role: 'runner' },
    },
    'Record trusted runner evidence',
    `Verified candidate tree with ${validation.checks.length} deterministic checks; passed: true`
  );

  // 11. Human approval
  await execExpected(
    {
      type: 'approve',
      treeHash: candidateHash,
      actor: { id: 'human-lead', role: 'human' },
    },
    'Human review and approval',
    `Human approval recorded for exact candidate tree hash ${candidateHash.slice(0, 10)}...`
  );

  // 12. Integrate into baseline
  await execExpected(
    {
      type: 'integrate',
      actor: { id: 'human-lead', role: 'human' },
    },
    'Integrate candidate into baseline',
    'Advanced baseline to revision 1; tasks 1 & 2 marked integrated'
  );

  // 13. Context recovery verification
  const t1 = state.tasks.find((t) => t.id === 'task-telemetry-config');
  const t3 = state.tasks.find((t) => t.id === 'task-conflicting-config');
  if (t1?.context.notes.length && t3?.context.summary) {
    outcomes.push({
      label: 'Verify preserved checkpoint context',
      accepted: true,
      reason: `Task 1 context recovered (${t1.context.notes.length} notes); Task 3 retained unintegrated reasoning for rebase`,
    });
  } else {
    outcomes.push({
      label: 'Verify preserved checkpoint context',
      accepted: false,
      reason: 'Failed to recover task context from state',
    });
  }

  return { state, outcomes };
}
