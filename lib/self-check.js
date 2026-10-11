'use strict'

// 副作用のない内部検査。ネットワーク・書込み・子プロセス・同意の質問はしない。
// 例外は投げず、満たさない検査は problems に積む(途中で止めず、全部の検査を行う)。

const path = require('path')

// 読込後に関数として存在すべき export。キーは lib/ 配下のファイル名から .js を除いたもの
const REQUIRED_EXPORTS = {
  'binary-cache': ['normalizeCacheTag', 'cachePaths', 'isCacheValid', 'installBinary', 'syncBinary', 'prune'],
  'downloader': ['fetchPinnedMeta', 'fetchLatestMeta', 'downloadBinary'],
  'patcher': ['applyVA39Patch'],
  'audited-update': ['runUpdate', 'createDeps'],
  'errors': ['describeFailure', 'classifyNpmFailure', 'diagnoseLowSpace'],
  'run-npm': ['runNpm'],
  'install-state': ['checkPlacement', 'validateSigsysShim'],
  'notified': ['makeKey', 'loadNotified', 'hasNotified', 'recordNotified'],
  'consent': ['createConsent'],
  'render-final': ['renderFinal', 'renderUnknownResult', 'parseResult'],
  'run-sync-child': ['runSyncChild'],
}

const CONFIG_REL = path.join('config', 'agy-verified-versions.json')
const SHIM_REL = path.join('lib', 'native', 'sigsys_shim.so')
const PIN_STRING_FIELDS = ['tag_name', 'download_url', 'sha256_tar', 'sha256_binary']
const SHA256_HEX = /^[0-9a-fA-F]{64}$/

// pkgRoot: パッケージのルート(bin/ の親)
// fs: 既定は require('fs')。requireFn: 既定は本モジュールの require(pkgRoot 配下の絶対パスを読むのに使う)
function runSelfCheck({ pkgRoot, nonce, fs: fsImpl = require('fs'), requireFn = require } = {}) {
  const problems = []
  let version = null

  // (i) 主要モジュールの読込
  const loaded = {}
  for (const name of Object.keys(REQUIRED_EXPORTS)) {
    try {
      loaded[name] = requireFn(path.join(pkgRoot, 'lib', name + '.js'))
    } catch (e) {
      loaded[name] = null
      problems.push('require:' + name)
    }
  }

  // (ii) 必須 export が関数として存在すること(読込に失敗したモジュールの export は無いものとして扱う)
  for (const [name, exportNames] of Object.entries(REQUIRED_EXPORTS)) {
    const mod = loaded[name]
    for (const exp of exportNames) {
      const isFn = mod !== null && mod !== undefined && typeof mod[exp] === 'function'
      if (!isFn) problems.push(`export:${name}.${exp}`)
    }
  }

  // (iii) config/agy-verified-versions.json(フィールドは fetchPinnedMeta と同じくトップレベル)
  let pin = null
  let configOk = false
  try {
    pin = JSON.parse(fsImpl.readFileSync(path.join(pkgRoot, CONFIG_REL), 'utf8'))
    configOk = pin !== null && typeof pin === 'object' &&
      PIN_STRING_FIELDS.every((k) => typeof pin[k] === 'string') &&
      SHA256_HEX.test(pin.sha256_tar) &&
      SHA256_HEX.test(pin.sha256_binary)
  } catch (e) {
    configOk = false
  }
  if (!configOk) problems.push('config')

  // (iv) package.json の version と pin の tag_name(先頭の v は除いて比較)
  try {
    const pkg = JSON.parse(fsImpl.readFileSync(path.join(pkgRoot, 'package.json'), 'utf8'))
    if (pkg !== null && typeof pkg === 'object' && typeof pkg.version === 'string') {
      version = pkg.version
    }
  } catch (e) {
    version = null
  }
  if (version === null) {
    problems.push('package_json')
  } else if (pin !== null && typeof pin === 'object' && typeof pin.tag_name === 'string') {
    if (pin.tag_name.replace(/^v/, '') !== version) problems.push('version_mismatch')
  }

  // (v) SIGSYS shim の存在と ELF 構造(検査本体は lib/install-state.js の validateSigsysShim)
  let shimOk = false
  try {
    const { validateSigsysShim } = requireFn(path.join(pkgRoot, 'lib', 'install-state.js'))
    const buf = fsImpl.readFileSync(path.join(pkgRoot, SHIM_REL))
    const result = validateSigsysShim(buf)
    shimOk = !!(result && result.ok === true)
  } catch (e) {
    shimOk = false
  }
  if (!shimOk) problems.push('shim')

  const ok = problems.length === 0
  const line = ok && typeof nonce === 'string' ? 'SELF_CHECK_OK ' + nonce + ' ' + version : null
  return { ok, problems, version, line }
}

module.exports = { runSelfCheck, REQUIRED_EXPORTS }
