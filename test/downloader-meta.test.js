'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')

const DOWNLOADER = require.resolve('../lib/downloader')
const CONFIG = require.resolve('../config/agy-verified-versions.json')

// config を差し替えて lib/downloader を読み直す（VERIFIED_VERSIONS は読込み時に決まるため）。
// 読込み後は require.cache を元に戻す。
function loadWithConfig(cfg) {
  const savedConfig = require.cache[CONFIG]
  const savedDownloader = require.cache[DOWNLOADER]
  require.cache[CONFIG] = { id: CONFIG, filename: CONFIG, loaded: true, exports: cfg, children: [], paths: [] }
  delete require.cache[DOWNLOADER]
  try {
    return require('../lib/downloader')
  } finally {
    delete require.cache[DOWNLOADER]
    if (savedDownloader) require.cache[DOWNLOADER] = savedDownloader
    if (savedConfig) require.cache[CONFIG] = savedConfig
    else delete require.cache[CONFIG]
  }
}

// 試験用の固定値（版数・日付はハードコードしない）
const BASE = {
  tag_name: 'TEST-TAG',
  download_url: 'https://example.invalid/agy_fixture.tar.gz',
  sha256_tar: 'tar-fixture',
  sha256_binary: 'bin-fixture',
}

const VA39_KEYS = {
  va39_patcher_rev: 'rev-fixture',
  va39_patch_counts: { ubfx: 1, lsl: 2, mask: 0, mmap: 3, word: 4 },
  va39_patch_breakdown: { site: 'fixture' },
  va39_patched_sha256: 'patched-sha-fixture',
  va39_patched_size: 1234,
}

test('fetchPinnedMeta: 5欄すべてあれば expectation は5欄をそのまま持つ', async () => {
  const { fetchPinnedMeta } = loadWithConfig({ ...BASE, ...VA39_KEYS })
  const meta = await fetchPinnedMeta()
  assert.deepStrictEqual(meta.expectation, VA39_KEYS)
})

test('fetchPinnedMeta: 5欄すべて無い（旧記録）なら expectation は undefined', async () => {
  const { fetchPinnedMeta } = loadWithConfig({ ...BASE })
  const meta = await fetchPinnedMeta()
  assert.equal(meta.expectation, undefined)
})

test('fetchPinnedMeta: 一部だけある場合は存在する欄だけを持つ', async () => {
  const { fetchPinnedMeta } = loadWithConfig({
    ...BASE,
    va39_patcher_rev: VA39_KEYS.va39_patcher_rev,
    va39_patched_size: VA39_KEYS.va39_patched_size,
  })
  const meta = await fetchPinnedMeta()
  assert.deepStrictEqual(meta.expectation, {
    va39_patcher_rev: VA39_KEYS.va39_patcher_rev,
    va39_patched_size: VA39_KEYS.va39_patched_size,
  })
  assert.deepStrictEqual(Object.keys(meta.expectation).sort(), ['va39_patched_size', 'va39_patcher_rev'])
})

test('fetchPinnedMeta: 既存の4キーは従来どおり', async () => {
  const { fetchPinnedMeta } = loadWithConfig({ ...BASE, ...VA39_KEYS })
  const meta = await fetchPinnedMeta()
  assert.equal(meta.tagName, BASE.tag_name)
  assert.equal(meta.downloadUrl, BASE.download_url)
  assert.equal(meta.sha256Tar, BASE.sha256_tar)
  assert.equal(meta.sha256Binary, BASE.sha256_binary)
})

test('fetchPinnedMeta: sha256_tar / sha256_binary 欠落時は従来どおり例外', async () => {
  const noTar = loadWithConfig({ ...BASE, sha256_tar: undefined, ...VA39_KEYS }).fetchPinnedMeta
  await assert.rejects(noTar(), /sha256_tar/)

  const noBin = loadWithConfig({ ...BASE, sha256_binary: undefined, ...VA39_KEYS }).fetchPinnedMeta
  await assert.rejects(noBin(), /sha256_binary/)
})
