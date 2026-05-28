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

import type { Severity } from './sca-scanner.ts';
import type { EffectiveStatus, RiskVM } from './view-model';

export type RiskFilterPredicate = (risk: RiskVM) => boolean;

export interface RiskFilterDescription {
  effectiveStatuses: EffectiveStatus[];
  discardedStatuses: EffectiveStatus[];
  effectiveSeverities: Severity[];
  discardedSeverities: Severity[];
}
export interface RiskFilter {
  description: RiskFilterDescription;
  predicate: RiskFilterPredicate;
}

const EFFECTIVE_STATUSES = [
  'NEW',
  'OPEN',
  'CONFIRM',
  'ACCEPT',
  'SAFE',
  'FIXED',
] as const satisfies readonly EffectiveStatus[];

export const STATUS_PRESETS = ['active', 'to_fix', 'all'] as const;
export type StatusPreset = (typeof STATUS_PRESETS)[number];

const PRESET_EXPANSIONS: Record<StatusPreset, EffectiveStatus[]> = {
  active: ['NEW', 'OPEN', 'CONFIRM'],
  to_fix: ['NEW', 'OPEN', 'CONFIRM', 'ACCEPT'],
  all: [...EFFECTIVE_STATUSES],
};

const EFFECTIVE_SEVERITIES = [
  'BLOCKER',
  'HIGH',
  'MEDIUM',
  'LOW',
  'INFO',
] as const satisfies readonly Severity[];

export const SEVERITY_PRESETS = ['all'] as const;
export type SeverityPreset = (typeof SEVERITY_PRESETS)[number];

const SEVERITY_PRESET_EXPANSIONS: Record<SeverityPreset, Severity[]> = {
  all: [...EFFECTIVE_SEVERITIES],
};

export function buildRiskFilter(statuses: string, severities = 'all'): RiskFilter | null {
  const statusSet = parseStatuses(statuses);
  if (statusSet === null) return null;

  const severitySet = parseSeverities(severities);
  if (severitySet === null) return null;

  return {
    description: {
      effectiveStatuses: EFFECTIVE_STATUSES.filter((s) => statusSet.has(s)),
      discardedStatuses: EFFECTIVE_STATUSES.filter((s) => !statusSet.has(s)),
      effectiveSeverities: EFFECTIVE_SEVERITIES.filter((s) => severitySet.has(s)),
      discardedSeverities: EFFECTIVE_SEVERITIES.filter((s) => !severitySet.has(s)),
    },
    predicate: (risk) => statusSet.has(risk.status) && severitySet.has(risk.severity),
  };
}

function parseStatuses(input: string): Set<EffectiveStatus> | null {
  const tokens = input.split(',').map((s) => s.trim().toLowerCase());
  const set = new Set<EffectiveStatus>();

  for (const token of tokens) {
    if ((STATUS_PRESETS as readonly string[]).includes(token)) {
      for (const status of PRESET_EXPANSIONS[token as StatusPreset]) {
        set.add(status);
      }
    } else {
      const status = EFFECTIVE_STATUSES.find((s) => s.toLowerCase() === token);
      if (!status) return null;
      set.add(status);
    }
  }

  return set.size === 0 ? null : set;
}

function parseSeverities(input: string): Set<Severity> | null {
  const tokens = input.split(',').map((s) => s.trim().toLowerCase());
  const set = new Set<Severity>();

  for (const token of tokens) {
    if ((SEVERITY_PRESETS as readonly string[]).includes(token)) {
      for (const severity of SEVERITY_PRESET_EXPANSIONS[token as SeverityPreset]) {
        set.add(severity);
      }
    } else {
      const severity = EFFECTIVE_SEVERITIES.find((s) => s.toLowerCase() === token);
      if (!severity) return null;
      set.add(severity);
    }
  }

  return set.size === 0 ? null : set;
}
