'use strict';

/**
 * scripts/lib/api-base.js
 *
 * Resolves the active API base URL from PWD_API_URL (or --url). Mirrors the
 * backend-selection semantics of vm-manager's ORCHESTRATOR_API_BASE so the
 * same value can drive both clients.
 *
 * Two modes:
 *   - single base URL (passthrough)
 *   - semicolon-separated list of `url|cron` entries; cron is 5-field UTC
 *
 * Selection rules (per request, here per invocation):
 *   - exactly one backend matching `now` → its URL is used
 *   - zero matches  → NO_ACTIVE_BACKEND
 *   - >1 matches    → AMBIGUOUS_BACKEND (fail rather than route ambiguously)
 *
 * The returned URL is the bare host (e.g. `https://host`), trailing `/`
 * stripped. Callers append their own `/api/v1/...` paths.
 */

class ApiBaseConfigError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ApiBaseConfigError';
    this.code = code;
  }
}

const CRON_FIELD_BOUNDS = {
  minute: { min: 0, max: 59 },
  hour: { min: 0, max: 23 },
  dayOfMonth: { min: 1, max: 31 },
  month: { min: 1, max: 12 },
  dayOfWeek: { min: 0, max: 7 },
};

function normalizeUrl(url, index) {
  const trimmed = url.trim();
  const entryLabel =
    index === undefined ? 'PWD_API_URL' : `PWD_API_URL entry ${index + 1}`;

  if (!trimmed) {
    throw new ApiBaseConfigError('INVALID_CONFIG', `${entryLabel} is missing a backend URL`);
  }

  try {
    return new URL(trimmed).toString().replace(/\/$/, '');
  } catch {
    throw new ApiBaseConfigError(
      'INVALID_CONFIG',
      `${entryLabel} has an invalid backend URL: ${trimmed}`
    );
  }
}

function normalizeDayOfWeek(value) {
  return value === 7 ? 0 : value;
}

function parseRangePart(rawPart, fieldName, entryIndex) {
  const min = CRON_FIELD_BOUNDS[fieldName].min;
  const max = CRON_FIELD_BOUNDS[fieldName].max;
  const part = rawPart.trim();
  const entryLabel = `PWD_API_URL entry ${entryIndex + 1}`;

  if (!part) {
    throw new ApiBaseConfigError(
      'INVALID_CONFIG',
      `${entryLabel} has an empty ${fieldName} cron segment`
    );
  }

  if (part === '*') {
    return Array.from({ length: max - min + 1 }, (_, i) => min + i);
  }

  const parseNumber = (rawValue) => {
    if (!/^\d+$/.test(rawValue)) {
      throw new ApiBaseConfigError(
        'INVALID_CONFIG',
        `${entryLabel} has invalid ${fieldName} cron value "${rawValue}"`
      );
    }

    const numericValue = Number(rawValue);
    const normalizedValue =
      fieldName === 'dayOfWeek' ? normalizeDayOfWeek(numericValue) : numericValue;

    const upperBound = fieldName === 'dayOfWeek' ? 6 : max;
    if (normalizedValue < min || normalizedValue > upperBound) {
      throw new ApiBaseConfigError(
        'INVALID_CONFIG',
        `${entryLabel} has out-of-range ${fieldName} cron value "${rawValue}"`
      );
    }

    return normalizedValue;
  };

  if (!part.includes('-')) {
    return [parseNumber(part)];
  }

  const [startRaw, endRaw] = part.split('-');
  if (!startRaw || !endRaw || part.split('-').length !== 2) {
    throw new ApiBaseConfigError(
      'INVALID_CONFIG',
      `${entryLabel} has invalid ${fieldName} cron range "${part}"`
    );
  }

  const start = parseNumber(startRaw);
  const end = parseNumber(endRaw);
  if (start > end) {
    throw new ApiBaseConfigError(
      'INVALID_CONFIG',
      `${entryLabel} has descending ${fieldName} cron range "${part}"`
    );
  }

  return Array.from({ length: end - start + 1 }, (_, i) => start + i);
}

function parseCronField(rawField, fieldName, entryIndex) {
  const min = CRON_FIELD_BOUNDS[fieldName].min;
  const max = CRON_FIELD_BOUNDS[fieldName].max;
  const field = rawField.trim();
  const entryLabel = `PWD_API_URL entry ${entryIndex + 1}`;

  if (!field) {
    throw new ApiBaseConfigError(
      'INVALID_CONFIG',
      `${entryLabel} has an empty ${fieldName} cron field`
    );
  }

  const values = new Set();
  const wildcard = field === '*';

  for (const rawSegment of field.split(',')) {
    const segment = rawSegment.trim();
    if (!segment) {
      throw new ApiBaseConfigError(
        'INVALID_CONFIG',
        `${entryLabel} has an empty ${fieldName} cron segment`
      );
    }

    const [rangePart, stepPart, ...extraParts] = segment.split('/');
    if (extraParts.length > 0) {
      throw new ApiBaseConfigError(
        'INVALID_CONFIG',
        `${entryLabel} has invalid ${fieldName} cron segment "${segment}"`
      );
    }

    let step = 1;
    if (stepPart !== undefined) {
      if (!/^\d+$/.test(stepPart)) {
        throw new ApiBaseConfigError(
          'INVALID_CONFIG',
          `${entryLabel} has invalid ${fieldName} cron step "${stepPart}"`
        );
      }

      step = Number(stepPart);
      if (step <= 0) {
        throw new ApiBaseConfigError(
          'INVALID_CONFIG',
          `${entryLabel} has non-positive ${fieldName} cron step "${stepPart}"`
        );
      }
    }

    const rangeValues = parseRangePart(rangePart, fieldName, entryIndex);
    for (let i = 0; i < rangeValues.length; i += step) {
      values.add(rangeValues[i]);
    }
  }

  return { values, wildcard };
}

function parseCronExpression(expression, entryIndex) {
  const fields = expression.trim().split(/\s+/);
  const entryLabel = `PWD_API_URL entry ${entryIndex + 1}`;

  if (fields.length !== 5) {
    throw new ApiBaseConfigError(
      'INVALID_CONFIG',
      `${entryLabel} must use 5-field cron syntax in UTC: minute hour day-of-month month day-of-week`
    );
  }

  return {
    expression,
    minute: parseCronField(fields[0], 'minute', entryIndex),
    hour: parseCronField(fields[1], 'hour', entryIndex),
    dayOfMonth: parseCronField(fields[2], 'dayOfMonth', entryIndex),
    month: parseCronField(fields[3], 'month', entryIndex),
    dayOfWeek: parseCronField(fields[4], 'dayOfWeek', entryIndex),
  };
}

function matchesCronField(field, value) {
  return field.values.has(value);
}

function matchesCronExpression(expression, date) {
  const minute = date.getUTCMinutes();
  const hour = date.getUTCHours();
  const dayOfMonth = date.getUTCDate();
  const month = date.getUTCMonth() + 1;
  const dayOfWeek = date.getUTCDay();

  if (!matchesCronField(expression.minute, minute)) return false;
  if (!matchesCronField(expression.hour, hour)) return false;
  if (!matchesCronField(expression.month, month)) return false;

  const dayOfMonthMatches = matchesCronField(expression.dayOfMonth, dayOfMonth);
  const dayOfWeekMatches = matchesCronField(expression.dayOfWeek, dayOfWeek);

  if (expression.dayOfMonth.wildcard && expression.dayOfWeek.wildcard) {
    return true;
  }

  if (expression.dayOfMonth.wildcard) {
    return dayOfWeekMatches;
  }

  if (expression.dayOfWeek.wildcard) {
    return dayOfMonthMatches;
  }

  return dayOfMonthMatches || dayOfWeekMatches;
}

function parseScheduledBackend(entry, index) {
  const trimmedEntry = entry.trim();
  if (!trimmedEntry) {
    throw new ApiBaseConfigError(
      'INVALID_CONFIG',
      `PWD_API_URL entry ${index + 1} is empty`
    );
  }

  const separatorIndex = trimmedEntry.indexOf('|');
  if (separatorIndex === -1 || separatorIndex !== trimmedEntry.lastIndexOf('|')) {
    throw new ApiBaseConfigError(
      'INVALID_CONFIG',
      `PWD_API_URL entry ${index + 1} must use exactly one "|" separator`
    );
  }

  const url = normalizeUrl(trimmedEntry.slice(0, separatorIndex), index);
  const cron = trimmedEntry.slice(separatorIndex + 1).trim();
  if (!cron) {
    throw new ApiBaseConfigError(
      'INVALID_CONFIG',
      `PWD_API_URL entry ${index + 1} is missing a cron expression`
    );
  }

  return { url, cron, parsedCron: parseCronExpression(cron, index) };
}

function parseOrchestratorConfig(rawValue) {
  const trimmed = rawValue.trim();
  if (!trimmed) {
    throw new ApiBaseConfigError('INVALID_CONFIG', 'PWD_API_URL must not be empty');
  }

  if (!trimmed.includes('|') && !trimmed.includes(';')) {
    return { mode: 'single', url: normalizeUrl(trimmed) };
  }

  const entries = trimmed.split(';').map((e) => e.trim()).filter(Boolean);
  const backends = entries.map((entry, index) => parseScheduledBackend(entry, index));
  if (backends.length === 0) {
    throw new ApiBaseConfigError(
      'INVALID_CONFIG',
      'PWD_API_URL must include at least one backend entry'
    );
  }

  return { mode: 'scheduled', backends };
}

/**
 * Resolve the active API base URL for the given raw config string.
 * @param {string} rawBase - PWD_API_URL / --url value
 * @param {Date} [now=new Date()] - reference time (UTC used for cron matching)
 * @returns {string} bare host URL, trailing `/` stripped
 * @throws {ApiBaseConfigError} on invalid config, no active backend, or ambiguous match
 */
function resolveApiBase(rawBase, now = new Date()) {
  const config = parseOrchestratorConfig(rawBase);

  if (config.mode === 'single') {
    return config.url;
  }

  const matches = config.backends.filter((b) => matchesCronExpression(b.parsedCron, now));

  if (matches.length === 1) {
    return matches[0].url;
  }

  if (matches.length === 0) {
    throw new ApiBaseConfigError(
      'NO_ACTIVE_BACKEND',
      `No API backend is active for ${now.toISOString()} UTC`
    );
  }

  throw new ApiBaseConfigError(
    'AMBIGUOUS_BACKEND',
    `Multiple API backends match ${now.toISOString()} UTC: ${matches
      .map((b) => `${b.url}|${b.cron}`)
      .join(', ')}`
  );
}

module.exports = {
  ApiBaseConfigError,
  resolveApiBase,
  parseOrchestratorConfig,
  matchesCronExpression,
};
