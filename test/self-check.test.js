'use strict'

const { test } = require('node:test')
const assert = require('node:assert')
const path = require('path')
const fsReal = require('fs')

const { runSelfCheck, REQUIRED_EXPORTS } = require('../lib/self-check')

// 実ファイルは読まず、偽の fs / 偽の requireFn を注入する(一時ディレクトリは作らないため後始末は不要)
const ROOT = path.join(path.sep, 'fake-pkg-root')

const GOOD_PIN = {
  tag_name: '1.2.16',
  download_url: 'https://example.invalid/agy_cli_linux_arm64.tar.gz',
  sha256_tar: 'a'.repeat(64),
  sha256_binary: 'b'.repeat(64),
}

// 正常な shim は実物の .so を使う(validateSigsysShim の判定をそのまま通すため)
const REAL_SHIM = fsReal.readFileSync(path.join(__dirname, '..', 'lib', 'native', 'sigsys_shim.so'))
const REAL_INSTALL_STATE = require('../lib/install-state')

function relKey(p) {
  return path.relative(ROOT, p).split(path.sep).join('/')
}

// files: { 相対パス: string | Buffer | Error }
function makeFs(files) {
  return {
    readFileSync(p, enc) {
      const key = relKey(p)
      if (!Object.prototype.hasOwnProperty.call(files, key)) {
        const e = new Error(`ENOENT: no such file, open '${key}'`)
        e.code = 'ENOENT'
        throw e
      }
      const v = files[key]
      if (v instanceof Error) throw v
      const buf = typeof v === 'string' ? Buffer.from(v, 'utf8') : v
      return enc ? buf.toString(enc) : buf
    },
  }
}

// modules: { 相対パス: exports | Error }
function makeRequire(modules) {
  return function requireFn(p) {
    const key = relKey(p)
    if (!Object.prototype.hasOwnProperty.call(modules, key)) {
      const e = new Error(`Cannot find module '${key}'`)
      e.code = 'MODULE_NOT_FOUND'
      throw e
    }
    const v = modules[key]
    if (v instanceof Error) throw v
    return v
  }
}

function healthyModules() {
  const fns = (names) => Object.fromEntries(names.map((n) => [n, () => {}]))
  return {
    'lib/binary-cache.js': fns(REQUIRED_EXPORTS['binary-cache']),
    'lib/downloader.js': fns(REQUIRED_EXPORTS['downloader']),
    'lib/patcher.js': fns(REQUIRED_EXPORTS['patcher']),
    'lib/audited-update.js': fns(REQUIRED_EXPORTS['audited-update']),
    'lib/errors.js': fns(REQUIRED_EXPORTS['errors']),
    'lib/run-npm.js': fns(REQUIRED_EXPORTS['run-npm']),
    'lib/install-state.js': REAL_INSTALL_STATE,
    'lib/notified.js': fns(REQUIRED_EXPORTS['notified']),
    'lib/consent.js': fns(REQUIRED_EXPORTS['consent']),
    'lib/render-final.js': fns(REQUIRED_EXPORTS['render-final']),
    'lib/run-sync-child.js': fns(REQUIRED_EXPORTS['run-sync-child']),
    'lib/cache-lock.js': fns(REQUIRED_EXPORTS['cache-lock']),
    'lib/ensure-wiring.js': fns(REQUIRED_EXPORTS['ensure-wiring']),
    'lib/va39-expectation.js': fns(REQUIRED_EXPORTS['va39-expectation']),
    'lib/elf-scan.js': fns(REQUIRED_EXPORTS['elf-scan']),
  }
}

function healthyFiles(over = {}) {
  return Object.assign({
    'package.json': JSON.stringify({ name: '@bash0816/agy-termux', version: '1.2.16' }),
    'config/agy-verified-versions.json': JSON.stringify(GOOD_PIN),
    'lib/native/sigsys_shim.so': REAL_SHIM,
  }, over)
}

// opts: { files, modules, nonce }。nonce を省略すると 'n-1' を使う(undefined を明示すると nonce 無し)
function run(opts = {}) {
  const nonce = 'nonce' in opts ? opts.nonce : 'n-1'
  return runSelfCheck({
    pkgRoot: ROOT,
    nonce,
    fs: makeFs(opts.files || healthyFiles()),
    requireFn: makeRequire(opts.modules || healthyModules()),
  })
}

test('全部正常なら ok で、nonce があれば SELF_CHECK_OK 行を返す', () => {
  const r = run()
  assert.strictEqual(r.ok, true)
  assert.deepStrictEqual(r.problems, [])
  assert.strictEqual(r.version, '1.2.16')
  assert.strictEqual(r.line, 'SELF_CHECK_OK n-1 1.2.16')
})

test('nonce が無いと ok でも line は null', () => {
  const r = run({ nonce: undefined })
  assert.strictEqual(r.ok, true)
  assert.strictEqual(r.line, null)
  assert.strictEqual(r.version, '1.2.16')
})

test('nonce が文字列でなければ line は null', () => {
  const r = run({ nonce: 123 })
  assert.strictEqual(r.ok, true)
  assert.strictEqual(r.line, null)
})

test('ok でないときは line が null', () => {
  const r = run({ files: healthyFiles({ 'package.json': JSON.stringify({ version: '9.9.9' }) }) })
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.line, null)
})

test('モジュール読込失敗は require:<名前> になり、その export も無いものとして積まれる', () => {
  const modules = healthyModules()
  modules['lib/patcher.js'] = new Error('SyntaxError in patcher')
  const r = run({ modules })
  assert.strictEqual(r.ok, false)
  assert.deepStrictEqual(r.problems, ['require:patcher', 'export:patcher.applyVA39Patch'])
})

test('export が欠けていると export:<モジュール>.<名前> が積まれる', () => {
  const modules = healthyModules()
  delete modules['lib/downloader.js'].fetchLatestMeta
  const r = run({ modules })
  assert.strictEqual(r.ok, false)
  assert.deepStrictEqual(r.problems, ['export:downloader.fetchLatestMeta'])
})

test('export が関数でない値(文字列)なら積まれる', () => {
  const modules = healthyModules()
  modules['lib/binary-cache.js'].prune = 'not a function'
  const r = run({ modules })
  assert.deepStrictEqual(r.problems, ['export:binary-cache.prune'])
})

test('config の JSON が壊れていると config が積まれる', () => {
  const r = run({ files: healthyFiles({ 'config/agy-verified-versions.json': '{ "tag_name": "1.2.16", ' }) })
  assert.strictEqual(r.ok, false)
  assert.deepStrictEqual(r.problems, ['config'])
  assert.strictEqual(r.version, '1.2.16')
})

test('config の欄が欠けていると config が積まれる', () => {
  const pin = { ...GOOD_PIN }
  delete pin.sha256_binary
  const r = run({ files: healthyFiles({ 'config/agy-verified-versions.json': JSON.stringify(pin) }) })
  assert.deepStrictEqual(r.problems, ['config'])
})

test('config の欄が文字列でなければ config が積まれる', () => {
  const pin = { ...GOOD_PIN, download_url: 42 }
  const r = run({ files: healthyFiles({ 'config/agy-verified-versions.json': JSON.stringify(pin) }) })
  assert.deepStrictEqual(r.problems, ['config'])
})

test('sha256 が 63 桁・非16進のときは config が積まれる', () => {
  const short = { ...GOOD_PIN, sha256_tar: 'a'.repeat(63) }
  const nonHex = { ...GOOD_PIN, sha256_binary: 'g'.repeat(64) }
  assert.deepStrictEqual(
    run({ files: healthyFiles({ 'config/agy-verified-versions.json': JSON.stringify(short) }) }).problems,
    ['config'],
  )
  assert.deepStrictEqual(
    run({ files: healthyFiles({ 'config/agy-verified-versions.json': JSON.stringify(nonHex) }) }).problems,
    ['config'],
  )
})

test('package.json と pin の版が違うと version_mismatch', () => {
  const r = run({ files: healthyFiles({ 'package.json': JSON.stringify({ version: '1.2.15' }) }) })
  assert.strictEqual(r.ok, false)
  assert.deepStrictEqual(r.problems, ['version_mismatch'])
  assert.strictEqual(r.version, '1.2.15')
})

test('tag_name の先頭 v は無視して一致すれば OK', () => {
  const pin = { ...GOOD_PIN, tag_name: 'v1.2.16' }
  const r = run({ files: healthyFiles({ 'config/agy-verified-versions.json': JSON.stringify(pin) }) })
  assert.strictEqual(r.ok, true)
  assert.deepStrictEqual(r.problems, [])
  assert.strictEqual(r.line, 'SELF_CHECK_OK n-1 1.2.16')
})

test('shim が無いと shim が積まれる', () => {
  const files = healthyFiles()
  delete files['lib/native/sigsys_shim.so']
  const r = run({ files })
  assert.strictEqual(r.ok, false)
  assert.deepStrictEqual(r.problems, ['shim'])
})

test('shim の ELF が途中で切れていると shim が積まれる', () => {
  const truncated = REAL_SHIM.subarray(0, Math.floor(REAL_SHIM.length / 2))
  const r = run({ files: healthyFiles({ 'lib/native/sigsys_shim.so': truncated }) })
  assert.deepStrictEqual(r.problems, ['shim'])
})

test('複数の失敗が同時にあるとすべて problems に入る', () => {
  const modules = healthyModules()
  modules['lib/patcher.js'] = new Error('boom')
  const r = run({
    modules,
    files: healthyFiles({
      'config/agy-verified-versions.json': '{ broken',
      'lib/native/sigsys_shim.so': undefined,
    }),
  })
  assert.strictEqual(r.ok, false)
  assert.deepStrictEqual(r.problems, ['require:patcher', 'export:patcher.applyVA39Patch', 'config', 'shim'])
})

test('版不一致と shim 失敗が同時でも両方入る', () => {
  const files = healthyFiles({ 'package.json': JSON.stringify({ version: '0.0.1' }) })
  delete files['lib/native/sigsys_shim.so']
  const r = run({ files })
  assert.deepStrictEqual(r.problems, ['version_mismatch', 'shim'])
})

test('fs・requireFn が例外を投げても例外にならず problems に積まれる', () => {
  const throwingFs = { readFileSync() { throw new Error('EIO') } }
  const throwingRequire = () => { throw new Error('require failed') }
  let r
  assert.doesNotThrow(() => {
    r = runSelfCheck({ pkgRoot: ROOT, nonce: 'x', fs: throwingFs, requireFn: throwingRequire })
  })
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.line, null)
  assert.strictEqual(r.version, null)
  assert.ok(r.problems.includes('require:binary-cache'))
  assert.ok(r.problems.includes('require:audited-update'))
  assert.ok(r.problems.includes('config'))
  assert.ok(r.problems.includes('package_json'))
  assert.ok(r.problems.includes('shim'))
})

test('pkgRoot が無くても例外を投げず ok=false を返す', () => {
  let r
  assert.doesNotThrow(() => {
    r = runSelfCheck({})
  })
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.line, null)
  assert.ok(r.problems.includes('config'))
  assert.ok(r.problems.includes('shim'))
})

const NEW_MODULES = ['errors', 'run-npm', 'install-state', 'notified', 'consent', 'render-final', 'run-sync-child']

for (const name of NEW_MODULES) {
  test(`新しい lib/${name}.js の読込失敗は require:${name} になる`, () => {
    const modules = healthyModules()
    modules[`lib/${name}.js`] = new Error(`Cannot find module '${name}'`)
    const r = run({ modules })
    assert.strictEqual(r.ok, false)
    assert.ok(r.problems.includes('require:' + name), JSON.stringify(r.problems))
  })
}

test('run-npm の export 欠落は export:run-npm.runNpm になる', () => {
  const modules = healthyModules()
  delete modules['lib/run-npm.js'].runNpm
  const r = run({ modules })
  assert.strictEqual(r.ok, false)
  assert.deepStrictEqual(r.problems, ['export:run-npm.runNpm'])
})

test('consent の export 欠落は export:consent.createConsent になる', () => {
  const modules = healthyModules()
  delete modules['lib/consent.js'].createConsent
  const r = run({ modules })
  assert.strictEqual(r.ok, false)
  assert.deepStrictEqual(r.problems, ['export:consent.createConsent'])
})

test('新しい VA39 モジュールの export 欠落は export:<モジュール>.<名前> になる', () => {
  const modules = healthyModules()
  delete modules['lib/va39-expectation.js'].validateExpectation
  delete modules['lib/elf-scan.js'].scanTargets
  delete modules['lib/binary-cache.js'].findUsableArtifact
  const r = run({ modules })
  assert.strictEqual(r.ok, false)
  assert.deepStrictEqual(r.problems.slice().sort(), [
    'export:binary-cache.findUsableArtifact',
    'export:elf-scan.scanTargets',
    'export:va39-expectation.validateExpectation',
  ])
})

test('render-final の export が関数でなければ export:render-final.renderFinal になる', () => {
  const modules = healthyModules()
  modules['lib/render-final.js'].renderFinal = 'not a function'
  const r = run({ modules })
  assert.strictEqual(r.ok, false)
  assert.deepStrictEqual(r.problems, ['export:render-final.renderFinal'])
})

test('実パッケージ全体を対象にすると ok になり、SELF_CHECK_OK 行を返す', () => {
  const repoRoot = path.join(__dirname, '..')
  const r = runSelfCheck({ pkgRoot: repoRoot, nonce: 'x' })
  assert.deepStrictEqual(r.problems, [])
  assert.strictEqual(r.ok, true)
  assert.strictEqual(r.line, 'SELF_CHECK_OK x ' + r.version)
})
