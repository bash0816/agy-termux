'use strict'

const { test, after } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const ROOT = path.resolve(__dirname, '..')
const AGY = path.join(ROOT, 'bin', 'agy.js')
const VERSION = require(path.join(ROOT, 'package.json')).version

const tmpDirs = []
function mkTmp(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}

after(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// HOME を空の一時ディレクトリに向けて bin/agy.js を実行する
function runAgy(agyPath, args, home) {
  return spawnSync(process.execPath, [agyPath, ...args], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home },
    timeout: 60000,
  })
}

function lastLine(text) {
  const lines = text.split('\n').filter((l) => l !== '')
  return lines[lines.length - 1]
}

test('--self-check=abc123: 終了コード 0、最終行は SELF_CHECK_OK abc123 <version>', () => {
  const home = mkTmp('agy-sc-home-')
  const r = runAgy(AGY, ['--self-check=abc123'], home)
  assert.strictEqual(r.status, 0, `stderr: ${r.stderr}`)
  assert.strictEqual(lastLine(r.stdout), `SELF_CHECK_OK abc123 ${VERSION}`)
})

test('--self-check (nonce なし): 終了コード 0、標準出力は空', () => {
  const home = mkTmp('agy-sc-home-')
  const r = runAgy(AGY, ['--self-check'], home)
  assert.strictEqual(r.status, 0, `stderr: ${r.stderr}`)
  assert.strictEqual(r.stdout, '')
})

test('lib/patcher.js を欠いたコピーでは --self-check=zzz が失敗し、SELF_CHECK_OK を出さない', () => {
  const home = mkTmp('agy-sc-home-')
  const copy = mkTmp('agy-sc-copy-')
  const copyRoot = path.join(copy, 'pkg')
  fs.cpSync(ROOT, copyRoot, { recursive: true })
  fs.rmSync(path.join(copyRoot, 'lib', 'patcher.js'), { force: true })
  const r = runAgy(path.join(copyRoot, 'bin', 'agy.js'), ['--self-check=zzz'], home)
  assert.strictEqual(r.status, 1)
  assert.strictEqual(r.stdout.includes('SELF_CHECK_OK'), false)
})

test('どのケースでも HOME は空のまま(何も書き込まれない)', () => {
  const home = mkTmp('agy-sc-home-')
  runAgy(AGY, ['--self-check=abc123'], home)
  runAgy(AGY, ['--self-check'], home)
  assert.deepStrictEqual(fs.readdirSync(home), [])
})

test('lib/run-npm.js を欠いたコピーでは --self-check=zzz が終了コード 1 で、SELF_CHECK_OK を出さない', () => {
  const home = mkTmp('agy-sc-home-')
  const copy = mkTmp('agy-sc-copy-')
  const copyRoot = path.join(copy, 'pkg')
  fs.cpSync(ROOT, copyRoot, { recursive: true })
  fs.rmSync(path.join(copyRoot, 'lib', 'run-npm.js'), { force: true })
  const r = runAgy(path.join(copyRoot, 'bin', 'agy.js'), ['--self-check=zzz'], home)
  assert.strictEqual(r.status, 1)
  assert.strictEqual(r.stdout.includes('SELF_CHECK_OK'), false)
})
