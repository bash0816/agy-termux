'use strict'

// 配置完了の判定と、SIGSYS shim(.so)の ELF 構造検査
// (fs・realpath・self-check 実行は引数で注入できる。例外は投げず problems に積む)

const path = require('path')
const { spawnSync } = require('child_process')

// 配置済みとみなすために必要なパッケージ内ファイル(pkgDir からの相対パス)
const REQUIRED_FILES = [
  'bin/agy.js',
  'lib/binary-cache.js',
  'lib/downloader.js',
  'lib/patcher.js',
  'lib/audited-update.js',
  'lib/errors.js',
  'lib/run-npm.js',
  'lib/install-state.js',
  'lib/notified.js',
  'lib/consent.js',
  'lib/render-final.js',
  'lib/run-sync-child.js',
  'lib/self-check.js',
  'lib/native/sigsys_shim.so',
  'config/agy-verified-versions.json',
]

// self-check が成功時に出力する行の接頭辞
const SELF_CHECK_PREFIX = 'SELF_CHECK_OK'

const ELF_HEADER_SIZE = 64
const ET_DYN = 3 // 共有オブジェクト
const EM_AARCH64 = 183
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER)

function fail(reason) {
  return { ok: false, reason }
}

// Buffer が完全な ELF64 AArch64 共有オブジェクトかを検査する(途中で切れたファイルを含め、表が範囲内にあること)
function validateSigsysShim(buf) {
  if (!Buffer.isBuffer(buf)) return fail('not_buffer')
  if (buf.length < ELF_HEADER_SIZE) return fail('too_short')
  if (buf[0] !== 0x7f || buf[1] !== 0x45 || buf[2] !== 0x4c || buf[3] !== 0x46) {
    return fail('bad_magic')
  }
  if (buf[4] !== 2) return fail('not_elf64') // EI_CLASS
  if (buf[5] !== 1) return fail('not_little_endian') // EI_DATA
  if (buf.readUInt16LE(16) !== ET_DYN) return fail('not_shared_object') // e_type
  if (buf.readUInt16LE(18) !== EM_AARCH64) return fail('not_aarch64') // e_machine

  // uint64 は BigInt で読む。Number に安全に収まらないオフセットは不合格
  const phoff = buf.readBigUInt64LE(32)
  const shoff = buf.readBigUInt64LE(40)
  if (phoff > MAX_SAFE || shoff > MAX_SAFE) return fail('offset_out_of_range')

  const phentsize = BigInt(buf.readUInt16LE(54))
  const phnum = BigInt(buf.readUInt16LE(56))
  const shentsize = BigInt(buf.readUInt16LE(58))
  const shnum = BigInt(buf.readUInt16LE(60))
  const total = BigInt(buf.length)

  if (phoff + phnum * phentsize > total) return fail('truncated_program_headers')
  if (shoff + shnum * shentsize > total) return fail('truncated_section_headers')
  return { ok: true }
}

// self-check の stdout の最後の非空行を返す(CR は除く)。無ければ null
function lastNonEmptyLine(text) {
  if (typeof text !== 'string') return null
  const lines = text
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => line.trim() !== '')
  return lines.length > 0 ? lines[lines.length - 1] : null
}

// 既定の self-check 実行(注入されなかった場合のみ使う)
function defaultRunSelfCheck(nodePath, args) {
  const result = spawnSync(nodePath, args, { encoding: 'utf8' })
  return { status: result.status, stdout: result.stdout }
}

// 配置が完了しているかを判定する
// ①package.json の version ②必須ファイル ③bin リンク を確認し、すべて満たす場合のみ ④self-check を実行する
function checkPlacement(opts) {
  const { pkgDir, prefix, expectedVersion, nonce } = opts
  const fsImpl = opts.fs || require('fs')
  const realpath = opts.realpath || require('fs').realpathSync
  const nodePath = opts.nodePath || process.execPath
  const runSelfCheck = opts.runSelfCheck || defaultRunSelfCheck
  const problems = []
  let version = null

  // ① package.json を読み、version が期待値と一致するか
  try {
    const pkg = JSON.parse(fsImpl.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'))
    if (!pkg || typeof pkg.version !== 'string') throw new Error('version がありません')
    version = pkg.version
  } catch (_) {
    problems.push('package.json')
  }
  if (version !== expectedVersion) problems.push('version')

  // ② 必須ファイルの存在
  for (const file of REQUIRED_FILES) {
    let exists = false
    try {
      exists = fsImpl.existsSync(path.join(pkgDir, file))
    } catch (_) {
      exists = false
    }
    if (!exists) problems.push(`missing:${file}`)
  }

  // ③ <prefix>/bin/agy が <pkgDir>/bin/agy.js の実体を指しているか
  let linkOk = false
  try {
    const linkPath = path.join(prefix, 'bin', 'agy')
    const target = path.join(pkgDir, 'bin', 'agy.js')
    linkOk = Boolean(fsImpl.existsSync(linkPath)) && realpath(linkPath) === realpath(target)
  } catch (_) {
    linkOk = false
  }
  if (!linkOk) problems.push('bin_link')

  // ④ ①〜③ がすべて満たされている場合のみ self-check を実行する
  if (problems.length === 0) {
    let selfOk = false
    try {
      const result = runSelfCheck(nodePath, [path.join(pkgDir, 'bin', 'agy.js'), '--self-check=' + nonce])
      selfOk = Boolean(
        result &&
          result.status === 0 &&
          lastNonEmptyLine(result.stdout) === `${SELF_CHECK_PREFIX} ${nonce} ${version}`
      )
    } catch (_) {
      selfOk = false
    }
    if (!selfOk) problems.push('self_check')
  }

  return { complete: problems.length === 0, version, problems }
}

module.exports = { REQUIRED_FILES, validateSigsysShim, checkPlacement, SELF_CHECK_PREFIX }
