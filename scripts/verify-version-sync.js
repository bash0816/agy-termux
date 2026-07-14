#!/usr/bin/env node
'use strict';
const fs = require('fs');

const PACKAGE_JSON_PATH = './package.json';
const VERIFIED_CONFIG_PATH = './config/agy-verified-versions.json';

function main() {
  let pkg, verified;
  try {
    pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf8'));
  } catch (e) {
    console.error(`Error: failed to read/parse ${PACKAGE_JSON_PATH}: ${e.message}`);
    process.exit(1);
  }
  try {
    verified = JSON.parse(fs.readFileSync(VERIFIED_CONFIG_PATH, 'utf8'));
  } catch (e) {
    console.error(`Error: failed to read/parse ${VERIFIED_CONFIG_PATH}: ${e.message}`);
    process.exit(1);
  }

  const pkgVersion = typeof pkg.version === 'string' ? pkg.version.trim() : '';
  const tagName = typeof verified.tag_name === 'string' ? verified.tag_name.trim() : '';

  if (!pkgVersion) {
    console.error(`Error: package.json version is empty or missing`);
    process.exit(1);
  }
  if (!tagName) {
    console.error(`Error: config/agy-verified-versions.json tag_name is empty or missing`);
    process.exit(1);
  }
  if (pkgVersion !== tagName) {
    console.error(`Error: version mismatch. package.json.version(${pkgVersion}) !== config.tag_name(${tagName})`);
    process.exit(1);
  }

  console.error(`✓ version sync verified: ${pkgVersion}`);
  process.exit(0);
}

main();
