import { describe, expect, it } from 'vitest';
import { fixtureFiles, runDemo, validateCandidate } from '../src/demo.js';
import type { Files } from '../src/contracts.js';

describe('Fixture Files & Validation', () => {
  it('exports baseline fixtureFiles containing service and routes configs', () => {
    expect(fixtureFiles['config/service.json']).toBeDefined();
    expect(fixtureFiles['config/routes.json']).toBeDefined();
  });

  it('validates baseline fixtureFiles successfully', () => {
    const result = validateCandidate(fixtureFiles);
    expect(result.passed).toBe(true);
    expect(result.checks.length).toBeGreaterThan(0);
    expect(result.checks.every((c) => c.startsWith('PASS'))).toBe(true);
  });

  describe('negative validation cases', () => {
    it('fails when JSON syntax is corrupted', () => {
      const corrupted: Files = {
        ...fixtureFiles,
        'config/service.json': '{ bad json',
      };
      const result = validateCandidate(corrupted);
      expect(result.passed).toBe(false);
      expect(result.checks.some((c) => c.includes('invalid JSON syntax'))).toBe(true);
    });

    it('fails when required file is missing', () => {
      const missing: Files = {
        'config/routes.json': fixtureFiles['config/routes.json'],
      };
      const result = validateCandidate(missing);
      expect(result.passed).toBe(false);
      expect(result.checks.some((c) => c.includes('missing'))).toBe(true);
    });

    it('fails when port is out of range', () => {
      const parsed = JSON.parse(fixtureFiles['config/service.json']);
      parsed.port = 80; // < 1024
      const invalid: Files = {
        ...fixtureFiles,
        'config/service.json': JSON.stringify(parsed),
      };
      const result = validateCandidate(invalid);
      expect(result.passed).toBe(false);
      expect(result.checks.some((c) => c.includes('port'))).toBe(true);
    });

    it('fails when semver format is invalid', () => {
      const parsed = JSON.parse(fixtureFiles['config/service.json']);
      parsed.version = 'v1.0';
      const invalid: Files = {
        ...fixtureFiles,
        'config/service.json': JSON.stringify(parsed),
      };
      const result = validateCandidate(invalid);
      expect(result.passed).toBe(false);
      expect(result.checks.some((c) => c.includes('semver'))).toBe(true);
    });

    it('fails when rateLimit is too low (< 10)', () => {
      const parsed = JSON.parse(fixtureFiles['config/service.json']);
      parsed.rateLimit = 5;
      const invalid: Files = {
        ...fixtureFiles,
        'config/service.json': JSON.stringify(parsed),
      };
      const result = validateCandidate(invalid);
      expect(result.passed).toBe(false);
      expect(result.checks.some((c) => c.includes('rateLimit'))).toBe(true);
    });

    it('fails when routes contain duplicate paths', () => {
      const invalid: Files = {
        ...fixtureFiles,
        'config/routes.json': JSON.stringify({
          routes: [
            { path: '/api/health', method: 'GET', enabled: true },
            { path: '/api/health', method: 'GET', enabled: true },
          ],
        }),
      };
      const result = validateCandidate(invalid);
      expect(result.passed).toBe(false);
      expect(result.checks.some((c) => c.includes('duplicate route path'))).toBe(true);
    });

    it('fails semantic check when metrics feature is enabled but /api/metrics route is missing', () => {
      const parsedService = JSON.parse(fixtureFiles['config/service.json']);
      parsedService.features.metrics = true;
      const invalid: Files = {
        'config/service.json': JSON.stringify(parsedService),
        'config/routes.json': fixtureFiles['config/routes.json'], // does not have /api/metrics
      };
      const result = validateCandidate(invalid);
      expect(result.passed).toBe(false);
      expect(result.checks.some((c) => c.includes('features.metrics'))).toBe(true);
    });

    it('fails semantic check when caching feature is enabled but rateLimit < 50', () => {
      const parsedService = JSON.parse(fixtureFiles['config/service.json']);
      parsedService.features.caching = true;
      parsedService.rateLimit = 20; // < 50
      const invalid: Files = {
        ...fixtureFiles,
        'config/service.json': JSON.stringify(parsedService),
      };
      const result = validateCandidate(invalid);
      expect(result.passed).toBe(false);
      expect(result.checks.some((c) => c.includes('caching'))).toBe(true);
    });
  });
});

describe('Scenario Execution (runDemo)', () => {
  it('runs deterministic concurrent collaboration scenario and captures outcomes', async () => {
    const { state, outcomes } = await runDemo();

    // Verify objective
    expect(state.objective).toContain('metrics');

    // Verify revision advanced to 1
    expect(state.revision).toBe(1);

    // Verify exactly 3 tasks were created
    expect(state.tasks.length).toBe(3);

    // Verify disjoint tasks 1 and 2 are integrated
    const task1 = state.tasks.find((t) => t.id === 'task-telemetry-config');
    const task2 = state.tasks.find((t) => t.id === 'task-metrics-route');
    const task3 = state.tasks.find((t) => t.id === 'task-conflicting-config');

    expect(task1).toBeDefined();
    expect(task2).toBeDefined();
    expect(task3).toBeDefined();

    expect(task1!.status).toBe('integrated');
    expect(task2!.status).toBe('integrated');
    expect(task3!.status).toBe('proposed'); // Not integrated due to conflict

    // Verify context preservation and recovery
    expect(task1!.context.summary).toContain('telemetry');
    expect(task1!.context.notes.length).toBe(2);
    expect(task3!.context.summary).toContain('9090');

    // Verify integrated baseline contents
    const integratedService = JSON.parse(state.baseline['config/service.json']);
    expect(integratedService.features.caching).toBe(true);
    expect(integratedService.features.metrics).toBe(true);
    expect(integratedService.rateLimit).toBe(200);

    const integratedRoutes = JSON.parse(state.baseline['config/routes.json']);
    expect(integratedRoutes.routes.some((r: { path: string }) => r.path === '/api/metrics')).toBe(true);

    // Verify baseline passes validation
    const baselineValidation = validateCandidate(state.baseline);
    expect(baselineValidation.passed).toBe(true);

    // Verify candidate was cleared upon integration
    expect(state.candidate).toBeUndefined();

    // Verify negative/rejected cases were captured in outcomes
    const rejectedOutcomes = outcomes.filter((o) => !o.accepted);
    expect(rejectedOutcomes.length).toBeGreaterThanOrEqual(4);

    expect(rejectedOutcomes.some((o) => o.label.includes('conflicting'))).toBe(true);
    expect(rejectedOutcomes.some((o) => o.label.includes('agent-forged'))).toBe(true);
    expect(rejectedOutcomes.some((o) => o.label.includes('stale/mismatched'))).toBe(true);
    expect(rejectedOutcomes.some((o) => o.label.includes('unapproved'))).toBe(true);

    // Verify positive outcomes
    const acceptedOutcomes = outcomes.filter((o) => o.accepted);
    expect(acceptedOutcomes.length).toBeGreaterThanOrEqual(8);
  });
});
