#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const CANDIDATE_CONFIG_PATH = './config/agy-candidate-version.json';

async function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('readable', () => {
      let chunk;
      while ((chunk = process.stdin.read()) !== null) {
        data += chunk;
      }
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

async function main() {
  try {
    const jsonStr = await readStdin();
    const candidateMeta = JSON.parse(jsonStr);

    // Validate required fields
    const requiredFields = [
      'tag_name', 'download_url', 'sha256_tar', 'sha256_binary',
      'va39_patch_counts', 'release_id', 'asset_id', 'source_repo',
      'detected_date', 'status'
    ];

    for (const field of requiredFields) {
      if (!(field in candidateMeta)) {
        throw new Error(`Missing required field: ${field}`);
      }
    }

    // Ensure config directory exists
    const configDir = path.dirname(CANDIDATE_CONFIG_PATH);
    fs.mkdirSync(configDir, { recursive: true });

    // Write to candidate config file
    fs.writeFileSync(
      CANDIDATE_CONFIG_PATH,
      JSON.stringify(candidateMeta, null, 2) + '\n'
    );

    console.log(`Candidate config written to ${CANDIDATE_CONFIG_PATH}`);
  } catch (e) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  }
}

main();
