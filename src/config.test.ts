// Every project listed in config/projects.json loads eagerly at import time
// (see loadProjects()), and one missing its PROJECT_API_KEY_<ID> env var
// throws and takes the WHOLE service down with it — not just that project.
// This pins that every currently-registered project actually loads.

import test from 'node:test';
import assert from 'node:assert/strict';
import { getProjectById } from './config.ts';

test('every project registered in config/projects.json loads with a real API key', () => {
  for (const id of ['store', 'qareeb', 'fireworks']) {
    const project = getProjectById(id);
    assert.ok(project, `project "${id}" did not load`);
    assert.ok(project!.apiKey.length > 0, `project "${id}" has no API key`);
  }
});

test('the fireworks-store project is reachable by id and carries its own brand name', () => {
  const project = getProjectById('fireworks');
  assert.ok(project);
  assert.equal(project!.brandName, 'متجر الألعاب النارية');
});

test('an unregistered project id is not silently found', () => {
  assert.equal(getProjectById('not-a-real-project'), undefined);
});
