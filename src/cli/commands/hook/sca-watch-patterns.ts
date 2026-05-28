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

import picomatch from 'picomatch';

import logger from '../../../lib/logger';
import { spawnProcess } from '../../../lib/process';

interface WatchPatternsPayload {
  patterns?: unknown;
}

/**
 * Invokes `<sca-scanner> watch-patterns` and returns the parsed glob list.
 * Returns [] on any failure (non-zero exit, malformed JSON, missing patterns) —
 * callers should treat an empty list as "skip the scan".
 */
export async function getScaWatchPatterns(binaryPath: string): Promise<string[]> {
  try {
    const result = await spawnProcess(binaryPath, ['watch-patterns']);
    if ((result.exitCode ?? 1) !== 0) {
      logger.debug(`watch-patterns exited with code ${String(result.exitCode)}`);
      return [];
    }
    const stdout = result.stdout;
    const jsonStart = stdout.indexOf('{');
    if (jsonStart < 0) {
      logger.debug('watch-patterns produced no JSON payload');
      return [];
    }
    const parsed: WatchPatternsPayload = JSON.parse(
      stdout.slice(jsonStart),
    ) as WatchPatternsPayload;
    if (!Array.isArray(parsed.patterns)) return [];
    return parsed.patterns.filter((p): p is string => typeof p === 'string');
  } catch (err) {
    logger.debug(`watch-patterns failed: ${(err as Error).message}`);
    return [];
  }
}

/**
 * Returns true if any file matches any of the provided glob patterns.
 *
 * `watch-patterns` mixes bare filenames (`package.json`, `*.csproj`) with
 * path-style globs (`**\/obj/project.assets.json`, `requirements/*.txt`).
 * Patterns without `/` are matched against the basename (so `package.json`
 * matches `frontend/package.json`); patterns with `/` are matched against
 * the full path. `nocase` covers Windows path casing.
 *
 * Picomatch's own `matchBase` option misbehaves when an array also contains
 * `/`-bearing patterns, so we run two matchers instead.
 */
export function anyFileMatches(files: readonly string[], patterns: readonly string[]): boolean {
  if (patterns.length === 0 || files.length === 0) return false;
  const basenamePatterns = patterns.filter((p) => !p.includes('/'));
  const pathPatterns = patterns.filter((p) => p.includes('/'));
  const matchBasename =
    basenamePatterns.length > 0
      ? picomatch(basenamePatterns, { dot: true, nocase: true })
      : () => false;
  const matchPath =
    pathPatterns.length > 0 ? picomatch(pathPatterns, { dot: true, nocase: true }) : () => false;
  return files.some((file) => {
    const normalized = file.replace(/\\/g, '/');
    const basename = normalized.slice(normalized.lastIndexOf('/') + 1);
    return matchBasename(basename) || matchPath(normalized);
  });
}
