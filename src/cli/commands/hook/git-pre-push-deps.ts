/*
 * SonarQube CLI
 * Copyright (C) SonarSource Sàrl
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

// git pre-push callback handler — runs SCA dependency-risks analysis on pushes
// that touch dependency manifests. Skips silently when no manifests changed,
// fails-open on infra errors (auth/binary missing, scanner failure), blocks the
// push only when risks matching the configured filter are found.

import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveAuth } from '../../../lib/auth-resolver';
import { CLI_DIR } from '../../../lib/config-constants';
import logger, { getLogLevelConfig } from '../../../lib/logger';
import { SonarQubeClient } from '../../../sonarqube/client';
import { print, warn } from '../../../ui';
import { CommandFailedError } from '../_common/error';
import { resolveScaScannerBinaryPath } from '../_common/install/sca-scanner';
import { parseAnalysisProperties } from '../analyze/dependency-risk-helpers/analysis-properties';
import { DefaultScaScannerSpawner } from '../analyze/dependency-risk-helpers/default-sca-scanner-spawner';
import { buildRiskFilter } from '../analyze/dependency-risk-helpers/risk-filter';
import { assertServerSupportsLocalSca } from '../analyze/dependency-risk-helpers/sca-availability';
import {
  type ScaScannerInvocation,
  ScaScannerRunner,
} from '../analyze/dependency-risk-helpers/sca-scanner';
import { buildScaUrls } from '../analyze/dependency-risk-helpers/sca-urls';
import { formatDependencyRisksTable } from '../analyze/dependency-risk-helpers/table';
import type { DependencyRisksViewModel } from '../analyze/dependency-risk-helpers/view-model';
import { buildDependencyRisksViewModel } from '../analyze/dependency-risk-helpers/view-model/build';
import { collectFilesForRefs, getEmptyTree } from './git-files';
import { anyFileMatches, getScaWatchPatterns } from './sca-watch-patterns';
import { readGitPushRefs } from './stdin';

export interface GitPrePushDepsOptions {
  project: string;
  statuses: string;
  severities: string;
}

class ScaScannerNoopInstaller {
  constructor(private readonly binaryPath: string) {}
  install(): Promise<string> {
    return Promise.resolve(this.binaryPath);
  }
}

export async function gitPrePushDeps(options: GitPrePushDepsOptions): Promise<void> {
  warn(`[trace] git-pre-push-deps invoked, project=${options.project}`); // todo remove

  const refs = await readGitPushRefs();
  warn(`[trace] readGitPushRefs -> ${refs.length} refs`); // todo remove
  if (refs.length === 0) return;

  const auth = await resolveAuth().catch(() => null);
  warn(
    `[trace] resolveAuth -> ${auth ? `ok (${auth.connectionType}, ${auth.serverUrl})` : 'null'}`,
  ); // todo remove
  if (!auth) {
    logger.debug('Dependency-risks hook: no auth, skipping.');
    return;
  }

  const binaryPath = resolveScaScannerBinaryPath();
  warn(`[trace] resolveScaScannerBinaryPath -> ${binaryPath ?? 'null'}`); // todo remove
  if (!binaryPath) {
    logger.debug('Dependency-risks hook: sca-scanner binary not installed, skipping.');
    return;
  }

  const patterns = await getScaWatchPatterns(binaryPath);
  warn(
    `[trace] watch-patterns -> ${patterns.length} patterns; sample=${JSON.stringify(patterns.slice(0, 5))}`,
  ); // todo remove
  if (patterns.length === 0) {
    logger.debug('Dependency-risks hook: no watch patterns returned, skipping.');
    return;
  }

  const emptyTree = await getEmptyTree();
  const filesByRef = await collectFilesForRefs(refs, emptyTree);
  const changedFiles = Array.from(filesByRef.values()).flat();
  warn(`[trace] changedFiles (${changedFiles.length}): ${JSON.stringify(changedFiles)}`); // todo remove
  const matched = anyFileMatches(changedFiles, patterns);
  warn(`[trace] anyFileMatches -> ${matched}`); // todo remove
  if (!matched) {
    logger.debug(
      'Dependency-risks hook: no dependency manifests changed in pushed commits, skipping.',
    );
    return;
  }

  const filter = buildRiskFilter(options.statuses, options.severities);
  warn(
    `[trace] buildRiskFilter(statuses='${options.statuses}', severities='${options.severities}') -> ${filter ? 'ok' : 'null'}`,
  ); // todo remove
  if (!filter) {
    warn(
      `Dependency-risks hook: invalid filter (statuses='${options.statuses}', severities='${options.severities}'); push not blocked.`,
    );
    return;
  }

  let viewModel;
  try {
    const client = new SonarQubeClient(auth.serverUrl, auth.token);
    warn(`[trace] checking SCA availability...`); // todo remove
    await assertServerSupportsLocalSca(auth, client);
    warn(`[trace] SCA availability ok`); // todo remove

    warn(`[trace] fetching project settings for ${options.project}...`); // todo remove
    const settings = await client.getProjectSettings(options.project);
    const properties = parseAnalysisProperties(settings);
    const { apiBaseUrl, downloadBaseUrl } = buildScaUrls(auth);

    const invocation: ScaScannerInvocation = {
      baseDir: process.cwd(),
      apiBaseUrl,
      downloadBaseUrl,
      sonarToken: auth.token,
      projectKey: options.project,
      cacheDir: join(CLI_DIR, 'sca-scanner-cache'),
      workDir: join(tmpdir(), `sonar-sca-${Date.now()}`),
      scannerProperties: properties.scaProperties,
      excludedPaths: properties.exclusions,
      includeGitIgnoredPaths: properties.includeGitIgnoredPaths,
      debug: getLogLevelConfig() === 'DEBUG',
    };

    warn(`[trace] running sca-scanner analyze-project...`); // todo remove
    const installer = new ScaScannerNoopInstaller(binaryPath);
    const result = await new ScaScannerRunner(installer, new DefaultScaScannerSpawner()).run(
      invocation,
    );
    warn(
      `[trace] scanner returned ${result.releases.length} releases, ${result.errors.length} errors`,
    ); // todo remove
    viewModel = buildDependencyRisksViewModel(result, filter);
    warn(`[trace] viewModel: ${viewModel.packages.length} packages after filter`); // todo remove
  } catch (err) {
    warn(`Dependency-risks scan failed; push not blocked. Reason: ${(err as Error).message}`);
    return;
  }

  const matchedCount = countSelectedRisks(viewModel);
  warn(`[trace] matchedCount=${matchedCount}`); // todo remove
  if (matchedCount === 0) return;

  print(formatDependencyRisksTable(viewModel));
  throw new CommandFailedError(
    `Dependency risks detected in pushed commits (${matchedCount} matching the configured filter).`,
    {
      remediationHint: `Run 'sonar analyze dependency-risks -p ${options.project} --statuses ${options.statuses} --severities ${options.severities}' to inspect, fix or accept the risks, then retry the push.`,
    },
  );
}

function countSelectedRisks(vm: DependencyRisksViewModel): number {
  let count = 0;
  for (const pkg of vm.packages) {
    for (const group of pkg.groups) {
      count += group.selectedRisks.length;
    }
  }
  return count;
}
