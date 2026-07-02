'use strict';

/**
 * Normalize version tag (strip 'v' prefix for comparison)
 * e.g. 'v1.0.16' -> '1.0.16', '1.0.16' -> '1.0.16'
 */
function normalizeVersion(v) {
  return String(v).replace(/^v/, '');
}

module.exports = { normalizeVersion };
