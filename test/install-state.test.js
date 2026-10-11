'use strict'

const { test } = require('node:test')
const assert = require('node:assert')
const path = require('path')

const {
  REQUIRED_FILES,
  validateSigsysShim,
  checkPlacement,
  SELF_CHECK_PREFIX,
} = require('../lib/install-state')

// 合成 ELF を組み立てる(既定: ELF64 LE 共有オブジェクト AArch64、program header 1 個、section header 2 個、ぴったり収まる長さ)
function makeElf(o = {}) {
  const cls = o.cls ?? 2
  const data = o.data ?? 1
  const type = o.type ?? 3
  const machine = o.machine ?? 183
  const phoff = o.phoff ?? 64
  const phnum = o.phnum ?? 1
  const phentsize = o.phentsize ?? 56
  const shoff = o.shoff ?? 64 + 56
  const shnum = o.shnum ?? 2
  const shentsize = o.shentsize ?? 64
  const size = o.size ?? 64 + 56 + 64 * 2
  const buf = Buffer.alloc(size)
  buf[0] = 0x7f
  buf[1] = 0x45 // 'E'
  buf[2] = 0x4c // 'L'
  buf[3] = 0x46 // 'F'
  buf[4] = cls
  buf[5] = data
  buf[6] = 1
  buf.writeUInt16LE(type, 16)
  buf.writeUInt16LE(machine, 18)
  buf.writeUInt32LE(1, 20)
  buf.writeBigUInt64LE(BigInt(phoff), 32)
  buf.writeBigUInt64LE(BigInt(shoff), 40)
  buf.writeUInt16LE(64, 52)
  buf.writeUInt16LE(phentsize, 54)
  buf.writeUInt16LE(phnum, 56)
  buf.writeUInt16LE(shentsize, 58)
  buf.writeUInt16LE(shnum, 60)
  buf.writeUInt16LE(0, 62)
  return buf
}

test('validateSigsysShim: 正常な合成 ELF は ok', () => {
  const r = validateSigsysShim(makeElf())
  assert.equal(r.ok, true)
  assert.equal(r.reason, undefined)
})

test('validateSigsysShim: 先頭マジックが不正なら不合格', () => {
  const buf = makeElf()
  buf[0] = 0x00
  assert.equal(validateSigsysShim(buf).ok, false)
})

test('validateSigsysShim: ELF32 は不合格', () => {
  const r = validateSigsysShim(makeElf({ cls: 1 }))
  assert.equal(r.ok, false)
  assert.equal(typeof r.reason, 'string')
})

test('validateSigsysShim: ビッグエンディアンは不合格', () => {
  const r = validateSigsysShim(makeElf({ data: 2 }))
  assert.equal(r.ok, false)
  assert.equal(typeof r.reason, 'string')
})

test('validateSigsysShim: e_type が 3 (共有オブジェクト) 以外は不合格', () => {
  const r = validateSigsysShim(makeElf({ type: 2 }))
  assert.equal(r.ok, false)
  assert.equal(typeof r.reason, 'string')
})

test('validateSigsysShim: e_machine が 183 (AArch64) 以外は不合格', () => {
  const r = validateSigsysShim(makeElf({ machine: 62 }))
  assert.equal(r.ok, false)
  assert.equal(typeof r.reason, 'string')
})

test('validateSigsysShim: セクションヘッダ表が範囲外(途中で切れたファイル)は不合格', () => {
  // 必要長は 248 バイト。247 バイトに切り詰める
  const r = validateSigsysShim(makeElf({ size: 247 }))
  assert.equal(r.ok, false)
  assert.equal(typeof r.reason, 'string')
})

test('validateSigsysShim: プログラムヘッダ表が範囲外は不合格', () => {
  // phnum=5 では 64 + 5*56 = 344 バイト必要。実長 248 を超える
  const r = validateSigsysShim(makeElf({ phnum: 5 }))
  assert.equal(r.ok, false)
  assert.equal(typeof r.reason, 'string')
})

test('validateSigsysShim: 64 バイト未満のバッファは不合格', () => {
  const buf = makeElf().subarray(0, 63)
  const r = validateSigsysShim(buf)
  assert.equal(r.ok, false)
  assert.equal(typeof r.reason, 'string')
})

test('validateSigsysShim: Number に収まらない巨大な e_shoff は不合格', () => {
  const r = validateSigsysShim(makeElf({ shoff: 2n ** 63n }))
  assert.equal(r.ok, false)
  assert.equal(typeof r.reason, 'string')
})

// ---- checkPlacement ----

const PKG = '/opt/agy/pkg'
const PREFIX = '/opt/agy/prefix'
const VERSION = '1.2.3'
const NONCE = 'n0nce'
const NODE = '/usr/bin/fake-node'
const LINK = path.join(PREFIX, 'bin', 'agy')
const ENTRY = path.join(PKG, 'bin', 'agy.js')

function okLine(nonce = NONCE, version = VERSION) {
  return `${SELF_CHECK_PREFIX} ${nonce} ${version}\n`
}

// 配置が完全に揃ったファイル集合(存在するパス => 内容)
function baseFiles(pkgJson) {
  const files = {}
  for (const f of REQUIRED_FILES) files[path.join(PKG, f)] = 'x'
  files[path.join(PKG, 'package.json')] = pkgJson ?? JSON.stringify({ version: VERSION })
  files[LINK] = 'link'
  return files
}

function fakeFs(files) {
  const has = (p) => Object.prototype.hasOwnProperty.call(files, p)
  return {
    existsSync: (p) => has(p),
    readFileSync: (p) => {
      if (!has(p)) {
        const e = new Error(`ENOENT: ${p}`)
        e.code = 'ENOENT'
        throw e
      }
      return files[p]
    },
  }
}

// links: パス => 実体パス。未指定のパスは自分自身を返す
function fakeRealpath(links) {
  return (p) => (Object.prototype.hasOwnProperty.call(links, p) ? links[p] : p)
}

// 既定は「すべて正常」。上書きしたい項目だけ指定する
function setup({ files, links, selfCheck, nodePath } = {}) {
  const calls = []
  const runSelfCheck = (np, args) => {
    calls.push({ nodePath: np, args })
    return selfCheck ? selfCheck() : { status: 0, stdout: okLine() }
  }
  const opts = {
    pkgDir: PKG,
    prefix: PREFIX,
    expectedVersion: VERSION,
    nonce: NONCE,
    fs: fakeFs(files ?? baseFiles()),
    realpath: fakeRealpath(links ?? { [LINK]: ENTRY }),
    runSelfCheck,
    nodePath: nodePath ?? NODE,
  }
  return { opts, calls }
}

test('checkPlacement: すべて正常なら complete', () => {
  const { opts, calls } = setup()
  const r = checkPlacement(opts)
  assert.deepStrictEqual(r, { complete: true, version: VERSION, problems: [] })
  assert.equal(calls.length, 1)
  assert.deepStrictEqual(calls[0].args, [ENTRY, '--self-check=' + NONCE])
  assert.equal(calls[0].nodePath, NODE)
})

test('checkPlacement: nodePath 未指定時は process.execPath を使う', () => {
  const { opts, calls } = setup()
  delete opts.nodePath
  const r = checkPlacement(opts)
  assert.equal(r.complete, true)
  assert.equal(calls[0].nodePath, process.execPath)
})

test('checkPlacement: version 不一致は不合格で、self-check を呼ばない', () => {
  const { opts, calls } = setup({ files: baseFiles(JSON.stringify({ version: '9.9.9' })) })
  const r = checkPlacement(opts)
  assert.equal(r.complete, false)
  assert.equal(r.version, '9.9.9')
  assert.deepStrictEqual(r.problems, ['version'])
  assert.equal(calls.length, 0)
})

test('checkPlacement: 必須ファイルが 1 つ欠落すると不合格で、self-check を呼ばない', () => {
  const files = baseFiles()
  delete files[path.join(PKG, 'lib', 'patcher.js')]
  const { opts, calls } = setup({ files })
  const r = checkPlacement(opts)
  assert.equal(r.complete, false)
  assert.deepStrictEqual(r.problems, ['missing:lib/patcher.js'])
  assert.equal(calls.length, 0)
})

test('checkPlacement: bin リンクが無いと不合格で、self-check を呼ばない', () => {
  const files = baseFiles()
  delete files[LINK]
  const { opts, calls } = setup({ files })
  const r = checkPlacement(opts)
  assert.equal(r.complete, false)
  assert.deepStrictEqual(r.problems, ['bin_link'])
  assert.equal(calls.length, 0)
})

test('checkPlacement: bin リンクが別の実体を指すと不合格で、self-check を呼ばない', () => {
  const { opts, calls } = setup({ links: { [LINK]: '/elsewhere/agy.js' } })
  const r = checkPlacement(opts)
  assert.equal(r.complete, false)
  assert.deepStrictEqual(r.problems, ['bin_link'])
  assert.equal(calls.length, 0)
})

test('checkPlacement: package.json が壊れていると不合格で、self-check を呼ばない', () => {
  const { opts, calls } = setup({ files: baseFiles('{ broken json') })
  const r = checkPlacement(opts)
  assert.equal(r.complete, false)
  assert.equal(r.version, null)
  assert.ok(r.problems.includes('package.json'))
  assert.equal(calls.length, 0)
})

test('checkPlacement: self-check の nonce が違うと不合格', () => {
  const { opts } = setup({ selfCheck: () => ({ status: 0, stdout: okLine('other') }) })
  const r = checkPlacement(opts)
  assert.equal(r.complete, false)
  assert.deepStrictEqual(r.problems, ['self_check'])
})

test('checkPlacement: self-check の version が違うと不合格', () => {
  const { opts } = setup({ selfCheck: () => ({ status: 0, stdout: okLine(NONCE, '0.0.1') }) })
  const r = checkPlacement(opts)
  assert.equal(r.complete, false)
  assert.deepStrictEqual(r.problems, ['self_check'])
})

test('checkPlacement: self-check の stdout に成功行が無いと不合格', () => {
  const { opts } = setup({ selfCheck: () => ({ status: 0, stdout: '' }) })
  const r = checkPlacement(opts)
  assert.equal(r.complete, false)
  assert.deepStrictEqual(r.problems, ['self_check'])
})

test('checkPlacement: 成功行が途中にあっても最後の非空行が違えば不合格', () => {
  const { opts } = setup({
    selfCheck: () => ({ status: 0, stdout: okLine() + 'extra output\n' }),
  })
  const r = checkPlacement(opts)
  assert.equal(r.complete, false)
  assert.deepStrictEqual(r.problems, ['self_check'])
})

test('checkPlacement: 末尾の空行を飛ばして最後の非空行が一致すれば complete', () => {
  const { opts } = setup({ selfCheck: () => ({ status: 0, stdout: okLine() + '\n\n' }) })
  const r = checkPlacement(opts)
  assert.equal(r.complete, true)
  assert.deepStrictEqual(r.problems, [])
})

test('checkPlacement: self-check の status が 0 以外だと不合格', () => {
  const { opts } = setup({ selfCheck: () => ({ status: 1, stdout: okLine() }) })
  const r = checkPlacement(opts)
  assert.equal(r.complete, false)
  assert.deepStrictEqual(r.problems, ['self_check'])
})

test('checkPlacement: runSelfCheck が例外を投げても例外は外へ出ず self_check を積む', () => {
  const { opts } = setup({
    selfCheck: () => {
      throw new Error('boom')
    },
  })
  let r
  assert.doesNotThrow(() => {
    r = checkPlacement(opts)
  })
  assert.equal(r.complete, false)
  assert.deepStrictEqual(r.problems, ['self_check'])
})
