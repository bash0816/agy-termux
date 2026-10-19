'use strict'

// ensureBinary の前半: 成果物の選択・原本の用意・パッチ・配置・失敗時の再確認
// 実ファイルシステム(mkdtemp の下)を使い、download / patch / acquireLock / sha256 は偽物を注入する

const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { ensureBinary, cachePaths } = require('../lib/binary-cache')
const { buildExpectation } = require('../lib/va39-expectation')
const { typedError, VA39_CODES } = require('../lib/errors')
const PATCHER_REV = require('../lib/patcher-rev.json').rev

// 偽の原本のサイズ。キャッシュ判定の最小サイズ(10 MiB)以上にする
const FAKE_BIN_SIZE = 10 * 1024 * 1024 + 4096
const PATCH_OFFSET = 100
const PATCH_COUNTS = Object.freeze({ ubfx: 3, lsl: 5, mask: 7, mmap: 2, word: 11 })

let tagSeq = 0
// テストごとに一意な数値形式のタグ(実在の版数は使わない)
function nextTag() {
  tagSeq += 1
  return `9.${tagSeq}.0`
}

// テスト用の一時ディレクトリ。終了時に削除する
function mkTmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ensure-binary-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

// 先頭が ELF マジックで、残りが決定的な内容の偽の原本
function makeBin(size = FAKE_BIN_SIZE, seed = 0) {
  const buf = Buffer.alloc(size)
  buf[0] = 0x7f
  buf.write('ELF', 1, 'latin1')
  for (let i = 4; i < size; i++) buf[i] = (i * 31 + seed * 7 + 13) & 0xff
  return buf
}

// in-place のパッチの偽物。先頭の ELF は保ち、1バイトだけ書き換えて件数と内訳を返す
function fakePatch(buf) {
  buf[PATCH_OFFSET] ^= 0xff
  return {
    ...PATCH_COUNTS,
    containers: [{ kind: 'main', offset: 0, size: buf.length, counts: { ...PATCH_COUNTS } }],
  }
}

// 原本のコピーにパッチを当てた結果(成果物の中身と戻り値)
function applyFakePatch(bin) {
  const buf = Buffer.from(bin)
  const result = fakePatch(buf)
  return { buf, result }
}

// 偽の原本から meta を組み立てる。期待値は偽の patch 結果から buildExpectation で作る
function makeMeta(bin, tagName = nextTag()) {
  const { buf, result } = applyFakePatch(bin)
  return {
    tagName,
    downloadUrl: `https://example.invalid/agy/${tagName}.tar.gz`,
    sha256Tar: sha256Hex(Buffer.from(`tar:${tagName}`)),
    sha256Binary: sha256Hex(bin),
    expectation: buildExpectation(result, {
      patchedSha256: sha256Hex(buf),
      patchedSize: buf.length,
      rev: PATCHER_REV,
    }),
  }
}

// 注入する依存一式。events は download / patch / hook の呼出し順、rec は呼出し回数などを記録する
// serve は既定の download が返す原本。hookFns は段階名ごとの追加動作
function makeDeps(overrides = {}) {
  const { serve, hookFns = {}, ...rest } = overrides
  const events = []
  const rec = { phases: [], releases: 0, downloads: 0, patches: 0 }
  let rnd = 0
  const deps = {
    fs,
    download: async () => {
      rec.downloads += 1
      events.push('download')
      if (serve === undefined) throw new Error('serve が指定されていません')
      return Buffer.from(serve)
    },
    patch: (buf) => {
      rec.patches += 1
      events.push('patch')
      return fakePatch(buf)
    },
    acquireLock: async () => ({
      acquired: true,
      release: () => {
        rec.releases += 1
      },
    }),
    sha256: sha256Hex,
    pid: 1234,
    now: () => 0,
    randomHex: () => {
      rnd += 1
      return rnd.toString(16).padStart(8, '0')
    },
    onPhase: (label) => {
      rec.phases.push(label)
    },
    progress: undefined,
    stallMs: 1000,
    patcherRev: PATCHER_REV,
    hooks: {
      at: async (name) => {
        events.push(`hook:${name}`)
        const fn = hookFns[name]
        if (fn) await fn()
      },
    },
    ...rest,
  }
  return { deps, rec, events }
}

function pathsOf(dir, meta, { isPatch = true, unverified = false } = {}) {
  return cachePaths({ dir, tag: meta.tagName, isPatch, unverified })
}

function ctxOf(dir, meta, extra = {}) {
  return { meta, dir, isPatch: true, ...extra }
}

function errWithCode(code, message) {
  const e = new Error(message || code)
  e.code = code
  return e
}

test('a) 有効な .va39r2 があれば cache。download は呼ばない', async (t) => {
  const dir = mkTmp(t)
  const bin = makeBin()
  const meta = makeMeta(bin)
  const p = pathsOf(dir, meta)
  fs.writeFileSync(p.file, applyFakePatch(bin).buf)
  const { deps, rec } = makeDeps({ serve: bin })

  const r = await ensureBinary(deps, ctxOf(dir, meta))

  assert.equal(r.source, 'cache')
  assert.equal(r.file, p.file)
  assert.equal(rec.downloads, 0)
  assert.equal(rec.patches, 0)
})

test('b) .bin だけ(SHA 一致)なら regenerated。download は呼ばず .bin は残り .va39r2 が生成される', async (t) => {
  const dir = mkTmp(t)
  const bin = makeBin()
  const meta = makeMeta(bin)
  const p = pathsOf(dir, meta)
  fs.writeFileSync(p.original, bin)
  const { deps, rec } = makeDeps({ serve: bin })

  const r = await ensureBinary(deps, ctxOf(dir, meta))

  assert.equal(r.source, 'regenerated')
  assert.equal(r.file, p.file)
  assert.equal(rec.downloads, 0)
  assert.equal(rec.patches, 1)
  assert.equal(fs.existsSync(p.original), true)
  assert.ok(fs.readFileSync(p.original).equals(bin))
  assert.equal(sha256Hex(fs.readFileSync(p.file)), meta.expectation.va39_patched_sha256)
})

test('c) 何も無ければ downloaded。.bin は patch より先に保存され、.va39r2 の sha256 は期待どおり', async (t) => {
  const dir = mkTmp(t)
  const bin = makeBin()
  const meta = makeMeta(bin)
  const p = pathsOf(dir, meta)
  let seen = null
  const { deps, rec, events } = makeDeps({
    serve: bin,
    hookFns: {
      'after-original-saved': () => {
        seen = { bin: fs.existsSync(p.original), va39r2: fs.existsSync(p.file) }
      },
    },
  })

  const r = await ensureBinary(deps, ctxOf(dir, meta))

  assert.equal(r.source, 'downloaded')
  assert.equal(r.file, p.file)
  assert.equal(fs.existsSync(r.file), true)
  // 保存の順序: download → .bin 保存後の段階 → patch
  assert.deepEqual(seen, { bin: true, va39r2: false })
  const iDownload = events.indexOf('download')
  const iSaved = events.indexOf('hook:after-original-saved')
  const iPatch = events.indexOf('patch')
  assert.ok(iDownload >= 0 && iDownload < iSaved && iSaved < iPatch, `順序: ${events.join(', ')}`)
  assert.ok(fs.readFileSync(p.original).equals(bin))
  assert.equal(sha256Hex(fs.readFileSync(p.file)), meta.expectation.va39_patched_sha256)
  assert.equal(rec.releases, 1)
})

test('d) patch が COUNT_MISMATCH → 例外。.va39r2 は無く .bin は残る。2回目は download せず再パッチだけ', async (t) => {
  const dir = mkTmp(t)
  const bin = makeBin()
  const meta = makeMeta(bin)
  const p = pathsOf(dir, meta)
  const badPatch = (buf) => {
    rec.patches += 1
    const result = fakePatch(buf)
    result.ubfx += 1
    return result
  }
  const { deps, rec } = makeDeps({ serve: bin, patch: badPatch })
  const isCountMismatch = (e) => e.code === VA39_CODES.COUNT_MISMATCH

  await assert.rejects(ensureBinary(deps, ctxOf(dir, meta)), isCountMismatch)
  assert.equal(fs.existsSync(p.file), false)
  assert.equal(fs.existsSync(p.original), true)
  assert.equal(rec.downloads, 1)

  await assert.rejects(ensureBinary(deps, ctxOf(dir, meta)), isCountMismatch)
  assert.equal(rec.downloads, 1, '2回目は download を呼ばない')
  assert.equal(rec.patches, 2)
  assert.equal(fs.existsSync(p.file), false)
  assert.equal(fs.existsSync(p.original), true)
})

test('e) patch が PATCH_UNSUPPORTED → そのまま伝播。.bin は残り、2回目は download しない', async (t) => {
  const dir = mkTmp(t)
  const bin = makeBin()
  const meta = makeMeta(bin)
  const p = pathsOf(dir, meta)
  const unsupported = () => {
    throw typedError(VA39_CODES.PATCH_UNSUPPORTED, { detail: '構造が想定と異なります' })
  }
  const { deps, rec } = makeDeps({ serve: bin, patch: unsupported })
  const isUnsupported = (e) => e.code === VA39_CODES.PATCH_UNSUPPORTED

  await assert.rejects(ensureBinary(deps, ctxOf(dir, meta)), isUnsupported)
  assert.equal(fs.existsSync(p.original), true)
  assert.equal(fs.existsSync(p.file), false)

  await assert.rejects(ensureBinary(deps, ctxOf(dir, meta)), isUnsupported)
  assert.equal(rec.downloads, 1, '2回目は download を呼ばない')
})

test('f) download が E_NET で失敗 → 何も保存されず例外。ロックは解放される', async (t) => {
  const dir = mkTmp(t)
  const bin = makeBin()
  const meta = makeMeta(bin)
  const p = pathsOf(dir, meta)
  const { deps, rec } = makeDeps({
    download: async () => {
      throw typedError('E_NET', { detail: 'network down' })
    },
  })

  await assert.rejects(ensureBinary(deps, ctxOf(dir, meta)), (e) => e.code === 'E_NET')
  assert.equal(fs.existsSync(p.original), false)
  assert.equal(fs.existsSync(p.file), false)
  assert.equal(rec.patches, 0)
  assert.equal(rec.releases, 1)
})

test('g) SHA 不一致の .bin は削除も改名もされない(download 時点で inode と内容が不変)。置換されるのは検証済み原本', async (t) => {
  const dir = mkTmp(t)
  const correct = makeBin(FAKE_BIN_SIZE, 0)
  const wrong = makeBin(FAKE_BIN_SIZE, 1)
  const meta = makeMeta(correct)
  const p = pathsOf(dir, meta)
  fs.writeFileSync(p.original, wrong)
  const inodeBefore = fs.statSync(p.original).ino
  let seenAtDownload = null
  const { deps, rec } = makeDeps({
    download: async () => {
      seenAtDownload = {
        ino: fs.statSync(p.original).ino,
        same: fs.readFileSync(p.original).equals(wrong),
      }
      return Buffer.from(correct)
    },
  })

  const r = await ensureBinary(deps, ctxOf(dir, meta))

  assert.equal(r.source, 'downloaded')
  assert.deepEqual(seenAtDownload, { ino: inodeBefore, same: true })
  assert.ok(fs.readFileSync(p.original).equals(correct), '検証済み原本に置換される')
  assert.equal(rec.patches, 1)
})

test('h) download が .va39r2 を置いてから E_STALL で失敗 → recovered', async (t) => {
  const dir = mkTmp(t)
  const bin = makeBin()
  const meta = makeMeta(bin)
  const p = pathsOf(dir, meta)
  const { deps, rec } = makeDeps({
    download: async () => {
      // 別プロセスが有効な成果物を置いた状況を再現する
      fs.writeFileSync(p.file, applyFakePatch(bin).buf)
      throw typedError('E_STALL', { detail: 'stalled' })
    },
  })

  const r = await ensureBinary(deps, ctxOf(dir, meta))

  assert.equal(r.source, 'recovered')
  assert.equal(r.file, p.file)
  assert.equal(fs.existsSync(r.file), true)
  assert.equal(rec.patches, 0)
})

test('i) .va39r2 の保存が ENOSPC で失敗しても、有効な成果物があれば recovered', async (t) => {
  const dir = mkTmp(t)
  const bin = makeBin()
  const meta = makeMeta(bin)
  const p = pathsOf(dir, meta)
  const fsWrap = {
    ...fs,
    renameSync(from, to) {
      if (to === p.file) {
        // 別プロセスが有効な成果物を置いた直後に、こちらの rename が ENOSPC で失敗する想定
        fs.writeFileSync(p.file, applyFakePatch(bin).buf)
        throw errWithCode('ENOSPC', 'ENOSPC: no space left on device')
      }
      return fs.renameSync(from, to)
    },
  }
  const { deps } = makeDeps({ fs: fsWrap, serve: bin })

  const r = await ensureBinary(deps, ctxOf(dir, meta))

  assert.equal(r.source, 'recovered')
  assert.equal(r.file, p.file)
  assert.equal(fs.existsSync(p.file), true)
})

test('j) 有効な成果物が無く .va39r2 の保存が ENOSPC → 元の環境エラーが伝播する', async (t) => {
  const dir = mkTmp(t)
  const bin = makeBin()
  const meta = makeMeta(bin)
  const p = pathsOf(dir, meta)
  const fsWrap = {
    ...fs,
    renameSync(from, to) {
      if (to === p.file) throw errWithCode('ENOSPC', 'ENOSPC: no space left on device')
      return fs.renameSync(from, to)
    },
  }
  const { deps } = makeDeps({ fs: fsWrap, serve: bin })

  await assert.rejects(ensureBinary(deps, ctxOf(dir, meta)), (e) => e.code === 'ENOSPC')
  assert.equal(fs.existsSync(p.file), false)
})

test('k1) 期待値が不正(欄の形が違う)なら、有効な成果物があっても EXPECTATION_MISSING。救済しない', async (t) => {
  const dir = mkTmp(t)
  const bin = makeBin()
  const meta = makeMeta(bin)
  const p = pathsOf(dir, meta)
  fs.writeFileSync(p.file, applyFakePatch(bin).buf)
  const badMeta = { ...meta, expectation: { ...meta.expectation, va39_patched_sha256: 'not-a-sha' } }
  const { deps, rec } = makeDeps({ serve: bin })

  await assert.rejects(
    ensureBinary(deps, ctxOf(dir, badMeta)),
    (e) => e.code === VA39_CODES.EXPECTATION_MISSING,
  )
  assert.equal(rec.downloads, 0)
  assert.equal(rec.patches, 0)
})

test('k2) 期待値が無ければ、有効な成果物があっても EXPECTATION_MISSING。救済しない', async (t) => {
  const dir = mkTmp(t)
  const bin = makeBin()
  const meta = makeMeta(bin)
  const p = pathsOf(dir, meta)
  fs.writeFileSync(p.file, applyFakePatch(bin).buf)
  const noExpectation = { ...meta, expectation: undefined }
  const { deps, rec } = makeDeps({ serve: bin })

  await assert.rejects(
    ensureBinary(deps, ctxOf(dir, noExpectation)),
    (e) => e.code === VA39_CODES.EXPECTATION_MISSING,
  )
  assert.equal(rec.downloads, 0)
})

test('待機中に他者が成果物を完成させたら waited。download は呼ばない', async (t) => {
  const dir = mkTmp(t)
  const bin = makeBin()
  const meta = makeMeta(bin)
  const p = pathsOf(dir, meta)
  const { deps, rec } = makeDeps({
    serve: bin,
    acquireLock: async (lockPath, opts) => {
      // 待機中に他者が有効な成果物を置いた状況を再現する
      fs.writeFileSync(p.file, applyFakePatch(bin).buf)
      const done = opts.checkDone()
      return { acquired: false, done }
    },
  })

  const r = await ensureBinary(deps, ctxOf(dir, meta))

  assert.equal(r.source, 'waited')
  assert.equal(r.file, p.file)
  assert.equal(rec.downloads, 0)
  assert.equal(rec.releases, 0)
})

test('ロックの取得に成功した処理では release が 1 回呼ばれる', async (t) => {
  const dir = mkTmp(t)
  const bin = makeBin()
  const meta = makeMeta(bin)
  const { deps, rec } = makeDeps({ serve: bin })

  const r = await ensureBinary(deps, ctxOf(dir, meta))

  assert.equal(r.source, 'downloaded')
  assert.equal(rec.releases, 1)
})

test('release が例外を投げても結果は変わらない', async (t) => {
  const dir = mkTmp(t)
  const bin = makeBin()
  const meta = makeMeta(bin)
  const p = pathsOf(dir, meta)
  const { deps } = makeDeps({
    serve: bin,
    acquireLock: async () => ({
      acquired: true,
      release: () => {
        throw new Error('release に失敗')
      },
    }),
  })

  const r = await ensureBinary(deps, ctxOf(dir, meta))

  assert.equal(r.source, 'downloaded')
  assert.equal(r.file, p.file)
  assert.equal(fs.existsSync(p.file), true)
})

test('.bin の保存が ENOSPC で、有効な成果物も無ければ ENOSPC が伝播する', async (t) => {
  const dir = mkTmp(t)
  const bin = makeBin()
  const meta = makeMeta(bin)
  const p = pathsOf(dir, meta)
  const fsWrap = {
    ...fs,
    renameSync(from, to) {
      if (to === p.original) throw errWithCode('ENOSPC', 'ENOSPC: no space left on device')
      return fs.renameSync(from, to)
    },
  }
  const { deps, rec } = makeDeps({ fs: fsWrap, serve: bin })

  await assert.rejects(ensureBinary(deps, ctxOf(dir, meta)), (e) => e.code === 'ENOSPC')
  assert.equal(fs.existsSync(p.original), false)
  assert.equal(fs.existsSync(p.file), false)
  assert.equal(rec.patches, 0)
  assert.equal(rec.releases, 1)
})

test('ロック取得が環境エラーでも、再確認で有効な成果物があれば recovered', async (t) => {
  const dir = mkTmp(t)
  const bin = makeBin()
  const meta = makeMeta(bin)
  const p = pathsOf(dir, meta)
  const { deps, rec } = makeDeps({
    serve: bin,
    acquireLock: async () => {
      fs.writeFileSync(p.file, applyFakePatch(bin).buf)
      throw errWithCode('EACCES', 'EACCES: permission denied')
    },
  })

  const r = await ensureBinary(deps, ctxOf(dir, meta))

  assert.equal(r.source, 'recovered')
  assert.equal(r.file, p.file)
  assert.equal(rec.downloads, 0)
})

test('成功後、同タグの旧世代 .va39 は削除され .bin は残る', async (t) => {
  const dir = mkTmp(t)
  const bin = makeBin()
  const meta = makeMeta(bin)
  const p = pathsOf(dir, meta)
  fs.writeFileSync(p.legacy, 'legacy-data')
  const { deps } = makeDeps({ serve: bin })

  const r = await ensureBinary(deps, ctxOf(dir, meta))

  assert.equal(r.source, 'downloaded')
  assert.equal(fs.existsSync(p.legacy), false)
  assert.equal(fs.existsSync(p.original), true)
})

test('VA48 は期待値が無くても拒否されず、download の後は cache になる', async (t) => {
  const dir = mkTmp(t)
  const bin = makeBin()
  const meta = { ...makeMeta(bin), expectation: undefined }
  const p = pathsOf(dir, meta, { isPatch: false })
  const { deps, rec } = makeDeps({ serve: bin })
  const ctx = { meta, dir, isPatch: false }

  const first = await ensureBinary(deps, ctx)
  assert.equal(first.source, 'downloaded')
  assert.equal(first.file, p.original)
  assert.equal(fs.existsSync(first.file), true)
  assert.equal(rec.downloads, 1)

  const second = await ensureBinary(deps, ctx)
  assert.equal(second.source, 'cache')
  assert.equal(second.file, p.original)
  assert.equal(rec.downloads, 1)
})

test('VA39 は .bin が有効でも .va39r2 が無ければ cache にならない(download 失敗で例外)', async (t) => {
  const dir = mkTmp(t)
  const bin = makeBin()
  const meta = makeMeta(bin)
  const p = pathsOf(dir, meta)
  // SHA が一致しない .bin は採用されないため、.bin だけでは成功しない
  const wrong = makeBin(FAKE_BIN_SIZE, 5)
  fs.writeFileSync(p.original, wrong)
  const { deps } = makeDeps({
    download: async () => {
      throw typedError('E_NET', { detail: 'network down' })
    },
  })

  await assert.rejects(ensureBinary(deps, ctxOf(dir, meta)), (e) => e.code === 'E_NET')
  assert.equal(fs.existsSync(p.file), false)
})

test('VA39 は期待サイズと違う .va39r2 を cache として採用しない', async (t) => {
  const dir = mkTmp(t)
  const bin = makeBin()
  const meta = makeMeta(bin)
  const p = pathsOf(dir, meta)
  fs.writeFileSync(p.file, Buffer.from(applyFakePatch(bin).buf.subarray(0, 1024)))
  const { deps, rec } = makeDeps({
    download: async () => {
      throw typedError('E_NET', { detail: 'network down' })
    },
  })

  await assert.rejects(ensureBinary(deps, ctxOf(dir, meta)), (e) => e.code === 'E_NET')
  assert.equal(rec.patches, 0)
})

test('unverified は unverified/ 配下に配置し、.bin を保存せず、期待値を見ない', async (t) => {
  const dir = mkTmp(t)
  const bin = makeBin()
  const meta = { ...makeMeta(bin), expectation: undefined }
  const pU = pathsOf(dir, meta, { unverified: true })
  const pMain = pathsOf(dir, meta)
  const { deps, rec } = makeDeps({ serve: bin })
  const ctx = { meta, dir, isPatch: true, unverified: true }

  const r = await ensureBinary(deps, ctx)

  assert.equal(r.source, 'downloaded')
  assert.equal(r.file, pU.file)
  assert.equal(path.dirname(r.file), path.join(dir, 'unverified'))
  assert.equal(fs.existsSync(r.file), true)
  assert.equal(sha256Hex(fs.readFileSync(r.file)), sha256Hex(applyFakePatch(bin).buf))
  assert.equal(fs.existsSync(pU.original), false, 'unverified では .bin を保存しない')
  assert.equal(fs.existsSync(pMain.original), false)
  assert.equal(rec.downloads, 1)
})

test('forceRefresh は既存の成果物を使わず download を呼ぶ', async (t) => {
  const dir = mkTmp(t)
  const bin = makeBin()
  const meta = makeMeta(bin)
  const p = pathsOf(dir, meta)
  fs.writeFileSync(p.file, applyFakePatch(bin).buf)
  fs.writeFileSync(p.original, bin)
  const { deps, rec } = makeDeps({ serve: bin })

  const r = await ensureBinary(deps, ctxOf(dir, meta, { forceRefresh: true }))

  assert.equal(rec.downloads, 1)
  assert.equal(r.source, 'downloaded')
  assert.equal(fs.existsSync(r.file), true)
})

test('forceRefresh で download が失敗しても、既存の有効な成果物があれば recovered', async (t) => {
  const dir = mkTmp(t)
  const bin = makeBin()
  const meta = makeMeta(bin)
  const p = pathsOf(dir, meta)
  fs.writeFileSync(p.file, applyFakePatch(bin).buf)
  const { deps, rec } = makeDeps({
    download: async () => {
      rec.downloads += 1
      throw typedError('E_HTTP', { httpStatus: 503, detail: 'unavailable' })
    },
  })

  const r = await ensureBinary(deps, ctxOf(dir, meta, { forceRefresh: true }))

  assert.equal(r.source, 'recovered')
  assert.equal(r.file, p.file)
  assert.equal(rec.downloads, 1)
})

test('forceRefresh: 生存中のロックの後で、待機前から有ったが古い成果物は完了扱いせず自分で取得する', async (t) => {
  const dir = mkTmp(t)
  const bin = makeBin()
  const meta = makeMeta(bin)
  const p = pathsOf(dir, meta)
  fs.writeFileSync(p.file, applyFakePatch(bin).buf)
  fs.writeFileSync(p.original, bin)
  const old = new Date(Date.now() - 60_000)
  fs.utimesSync(p.file, old, old)
  fs.utimesSync(p.original, old, old)
  const { deps, rec } = makeDeps({
    serve: bin,
    now: () => Date.now(),
    acquireLock: async (lockPath, opts) => {
      // 生存中のロックを待つ。待機中に新しい成果物は現れず、古いままなので checkDone は偽
      if (opts.checkDone()) return { acquired: false }
      return { acquired: true, release: () => {} }
    },
  })

  const r = await ensureBinary(deps, ctxOf(dir, meta, { forceRefresh: true }))

  assert.equal(rec.downloads, 1)
  assert.equal(r.source, 'downloaded')
  assert.notEqual(r.source, 'waited')
})

test('forceRefresh: 待機中に他者が新しく完成させた成果物は採用し、download は呼ばない', async (t) => {
  const dir = mkTmp(t)
  const bin = makeBin()
  const meta = makeMeta(bin)
  const p = pathsOf(dir, meta)
  fs.writeFileSync(p.file, applyFakePatch(bin).buf)
  fs.writeFileSync(p.original, bin)
  const old = new Date(Date.now() - 60_000)
  fs.utimesSync(p.file, old, old)
  fs.utimesSync(p.original, old, old)
  const { deps, rec } = makeDeps({
    serve: bin,
    now: () => Date.now(),
    acquireLock: async (lockPath, opts) => {
      // 待機中に他者が新しい成果物を完成させた状況(mtime は待機開始後になる)
      fs.writeFileSync(p.file, applyFakePatch(bin).buf)
      return { acquired: false, done: opts.checkDone() }
    },
  })

  const r = await ensureBinary(deps, ctxOf(dir, meta, { forceRefresh: true }))

  assert.equal(r.source, 'waited')
  assert.equal(r.file, p.file)
  assert.equal(rec.downloads, 0)
})
