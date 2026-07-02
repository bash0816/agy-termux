'use strict';

/**
 * Normalize version tag (strip 'v' prefix for comparison)
 * e.g. 'v1.0.16' -> '1.0.16', '1.0.16' -> '1.0.16'
 */
function normalizeVersion(v) {
  return String(v).replace(/^v/, '');
}

/**
 * Current date in Asia/Tokyo timezone, formatted as YYYY-MM-DD.
 * Shared by prepare-agy-candidate.js (detected_date) and
 * promote-agy-candidate.js (verified_date) so both timestamps are produced
 * the same way.
 */
function getTokyoDate() {
  return new Date().toLocaleDateString('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
}

module.exports = { normalizeVersion, getTokyoDate };
