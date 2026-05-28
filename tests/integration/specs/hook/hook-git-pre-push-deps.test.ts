/*
 * SonarQube CLI
 * Copyright (C) 2026 SonarSource Sàrl
 * mailto:info AT sonarsource DOT com
 *
 * This program is free software; you can redistribute it and/or
 * modify it under the terms of the GNU Lesser General Public
 * License as published by the Free Software Foundation; either
 * version 3 of the License, or (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
 * Lesser General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public License
 * along with this program; if not, write to the Free Software Foundation,
 * Inc., 51 Franklin Street, Fifth Floor, Boston, MA  02110-1301, USA.
 */

// Integration tests for `sonar hook git-pre-push-deps`:
// covers the graceful-skip paths and the manifest-detection gate. The
// "block on detected risk" path needs a fake SCA backend the in-process
// fake server does not implement (same constraint as analyze-dependency-risks
// integration tests) — covered there by exit-code assertions only.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { TestHarness } from '../../harness';
import { commitFile, initGitRepo } from './git-test-helpers';

const VALID_TOKEN = 'integration-test-token';
const TEST_ORG = 'my-org';
const FAKE_SERVER = 'http://localhost:19999';
const GIT_NULL_OID = '0000000000000000000000000000000000000000';
const CLEAN_CONTENT = 'const greeting = "hello world";';
const PACKAGE_JSON_CONTENT = '{"name":"demo","version":"1.0.0"}';

function pushRefLine(localSha: string, remoteSha: string, branch = 'refs/heads/main'): string {
  return `${branch} ${localSha} ${branch} ${remoteSha}\n`;
}

describe('sonar hook git-pre-push-deps', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it(
    'exits 0 when stdin is empty (no refs)',
    async () => {
      const result = await harness.run('hook git-pre-push-deps --project demo', { stdin: '' });
      expect(result.exitCode).toBe(0);
    },
    { timeout: 15000 },
  );

  it(
    'exits 0 when not authenticated (graceful skip)',
    async () => {
      harness.state().withScaScannerBinaryInstalled();
      const sha = 'abc1234abc1234abc1234abc1234abc1234abc123';
      const result = await harness.run('hook git-pre-push-deps --project demo', {
        stdin: pushRefLine(sha, GIT_NULL_OID),
      });
      expect(result.exitCode).toBe(0);
    },
    { timeout: 15000 },
  );

  it(
    'exits 0 when sca-scanner binary is not installed (graceful skip)',
    async () => {
      harness.withAuth(FAKE_SERVER, VALID_TOKEN, TEST_ORG);
      const sha = 'abc1234abc1234abc1234abc1234abc1234abc123';
      const result = await harness.run('hook git-pre-push-deps --project demo', {
        stdin: pushRefLine(sha, GIT_NULL_OID),
      });
      expect(result.exitCode).toBe(0);
    },
    { timeout: 15000 },
  );

  it(
    'exits 0 when pushed files contain no dependency manifests',
    async () => {
      initGitRepo(harness.cwd.path);
      const sha = commitFile(harness.cwd.path, 'index.ts', CLEAN_CONTENT);

      harness.state().withScaScannerBinaryInstalled();
      harness.withAuth(FAKE_SERVER, VALID_TOKEN, TEST_ORG);

      const result = await harness.run('hook git-pre-push-deps --project demo', {
        stdin: pushRefLine(sha, GIT_NULL_OID),
      });

      expect(result.exitCode).toBe(0);
    },
    { timeout: 30000 },
  );

  it(
    'exits 0 (fail-open) when a manifest changed but the SCA backend is unavailable',
    async () => {
      initGitRepo(harness.cwd.path);
      const sha = commitFile(harness.cwd.path, 'package.json', PACKAGE_JSON_CONTENT);

      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withScaEnabled(true)
        .withProject('demo')
        .withProjectSettings('demo', [])
        .start();
      harness.state().withScaScannerBinaryInstalled();
      harness.withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG);

      const result = await harness.run('hook git-pre-push-deps --project demo', {
        stdin: pushRefLine(sha, GIT_NULL_OID),
        timeoutMs: 45_000,
      });

      // Hook is fail-open on scanner failure: warn on stderr, push not blocked.
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain('push not blocked');
    },
    { timeout: 60000 },
  );

  it(
    'exits 0 with invalid filter values (warn + fail-open)',
    async () => {
      initGitRepo(harness.cwd.path);
      const sha = commitFile(harness.cwd.path, 'package.json', PACKAGE_JSON_CONTENT);

      harness.state().withScaScannerBinaryInstalled();
      harness.withAuth(FAKE_SERVER, VALID_TOKEN, TEST_ORG);

      const result = await harness.run('hook git-pre-push-deps --project demo --severities bogus', {
        stdin: pushRefLine(sha, GIT_NULL_OID),
      });

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain('invalid filter');
    },
    { timeout: 30000 },
  );
});
