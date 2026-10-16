'use strict'

// 生成キャッシュ用のアドバイザリロック（効率化目的。厳密な排他ではない）
// 完了済みならロックを取らずに抜ける。所有者が死んでいれば奪う。生存者のロックは時間だけでは奪わない。
// ロックは symlink で作る（リンク先に所有者情報の JSON を入れる）。内容が完成した状態でのみ存在する。

// symlink が使えない環境では openSync('wx') にフォールバックする
const SYMLINK_FALLBACK_CODES = ['EPERM', 'ENOSYS', 'EOPNOTSUPP', 'EACCES', 'EXDEV', 'EINVAL', 'ENAMETOOLONG']
// 環境起因のエラーは待機に回さず呼び出し元へ投げる
const ENV_ERROR_CODES = ['ENOSPC', 'EDQUOT', 'EACCES', 'EROFS']

async function acquireLock(deps, { lockPath, npmVersion, checkDone, onWait, pollMs = 500, noticeMs = 5000, staleUnknownMs = 10000 }) {
  const startedAt = deps.now()
  let lastNoticeAt = null
  // sleep から次の sleep までの間に除去したかどうか（除去は1区間につき1回まで）
  let removedSinceSleep = false

  for (;;) {
    const acquired = tryCreate(deps, lockPath, npmVersion)
    if (acquired !== null) return acquired

    const verdict = investigate(deps, lockPath, staleUnknownMs)
    if (verdict.dead && !removedSinceSleep && removeIfSame(deps, lockPath, verdict.judge)) {
      removedSinceSleep = true
      continue
    }

    if (await checkDone()) return { acquired: false, done: true }

    const elapsedMs = deps.now() - startedAt
    if (lastNoticeAt === null || elapsedMs - lastNoticeAt >= noticeMs) {
      onWait({ ownerPid: verdict.ownerPid, elapsedMs })
      lastNoticeAt = elapsedMs
    }

    await deps.sleep(pollMs)
    removedSinceSleep = false
  }
}

// 取得を試みる。取得できたら {acquired, release}、ロックが既にあれば null を返す。
// 環境エラーはそのまま throw する。
function tryCreate(deps, lockPath, npmVersion) {
  const fs = deps.fs
  const token = deps.randomHex() + deps.randomHex()
  const content = JSON.stringify({
    token,
    pid: deps.pid,
    procStart: readStartSafe(deps, deps.pid),
    npmVersion,
    createdAt: deps.now(),
  })

  try {
    // リンク先に JSON を入れて作る。作成は原子的で、内容が完成した状態でのみ見える
    fs.symlinkSync(content, lockPath)
  } catch (err) {
    if (err.code === 'EEXIST') return null
    if (SYMLINK_FALLBACK_CODES.includes(err.code)) return fallbackCreate(deps, lockPath, content, token)
    throw err
  }

  return makeAcquired(deps, lockPath, token)
}

// symlink が使えない環境用。openSync('wx') で通常ファイルとして作る。
function fallbackCreate(deps, lockPath, content, token) {
  const fs = deps.fs
  let fd
  try {
    fd = fs.openSync(lockPath, 'wx', 0o600)
  } catch (err) {
    if (err.code === 'EEXIST') return null
    throw err
  }

  try {
    const buf = Buffer.from(content, 'utf8')
    let offset = 0
    while (offset < buf.length) {
      offset += fs.writeSync(fd, buf, offset, buf.length - offset)
    }
    fs.closeSync(fd)
  } catch (err) {
    try {
      fs.closeSync(fd)
    } catch (_) {
      // 閉じられなくても続行する
    }
    // 自分が作った不完全なロックファイルを消してから投げる
    unlinkQuiet(fs, lockPath)
    throw err
  }

  return makeAcquired(deps, lockPath, token)
}

function makeAcquired(deps, lockPath, token) {
  return { acquired: true, release: makeRelease(deps, lockPath, token) }
}

// 所有者を調べる。dead が true なら除去候補。judge は除去時の同一性判定に使う。
function investigate(deps, lockPath, staleUnknownMs) {
  const fs = deps.fs
  const text = readLockText(fs, lockPath)
  // 中身が読めなければ同一性を確認できないので、除去せず待機に回す
  if (text === null) return { ownerPid: null, dead: false, judge: null }

  const owner = parseOwner(text)
  if (owner === null) {
    // 所有者不明。作成からの経過時間で失効を判定する
    let dead = false
    try {
      dead = deps.now() - fs.lstatSync(lockPath).mtimeMs > staleUnknownMs
    } catch (_) {
      dead = false
    }
    return { ownerPid: null, dead, judge: { kind: 'raw', raw: text } }
  }

  let dead = false
  if (killStatus(deps, owner.pid) === 'esrch') {
    dead = true
  } else {
    // PID 再利用の検出: 作成時と開始時刻が違えば別プロセス
    const currentStart = readStartSafe(deps, owner.pid)
    if (currentStart !== null && owner.procStart != null && currentStart !== owner.procStart) {
      dead = true
    }
  }
  return { ownerPid: owner.pid, dead, judge: { kind: 'token', token: owner.token } }
}

// 判定時と同じ所有者のままなら除去する。除去したら true。
function removeIfSame(deps, lockPath, judge) {
  const fs = deps.fs
  const text = readLockText(fs, lockPath)
  if (text === null) return false

  if (judge.kind === 'token') {
    const owner = parseOwner(text)
    if (owner === null || owner.token !== judge.token) return false
  } else if (text !== judge.raw) {
    return false
  }

  try {
    fs.unlinkSync(lockPath)
  } catch (err) {
    if (err.code === 'ENOENT') return true
    if (ENV_ERROR_CODES.includes(err.code)) throw err
    return false
  }
  return true
}

// 解放関数。自分の token のロックだけを消す。何度呼んでも例外を出さない。
function makeRelease(deps, lockPath, token) {
  return function release() {
    try {
      const owner = parseOwner(readLockText(deps.fs, lockPath))
      if (owner === null || owner.token !== token) return
      deps.fs.unlinkSync(lockPath)
    } catch (_) {
      // 既に消えている・読めない場合は何もしない
    }
  }
}

// ロックの中身を読む。symlink ならリンク先の文字列、通常ファイルなら内容。読めなければ null。
function readLockText(fs, lockPath) {
  try {
    return fs.readlinkSync(lockPath)
  } catch (err) {
    // 通常ファイルは EINVAL になるので、通常ファイルとして読む
    if (err.code !== 'EINVAL') return null
  }
  try {
    return fs.readFileSync(lockPath, 'utf8')
  } catch (_) {
    return null
  }
}

// 形の正しい所有者情報なら返す。それ以外は null（所有者不明扱い）。
function parseOwner(text) {
  let obj
  try {
    obj = JSON.parse(text)
  } catch (_) {
    return null
  }
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return null
  if (!Number.isInteger(obj.pid) || obj.pid <= 0) return null
  if (typeof obj.token !== 'string' || obj.token === '') return null
  return obj
}

function killStatus(deps, pid) {
  try {
    return deps.killPid(pid)
  } catch (_) {
    return 'unknown'
  }
}

function readStartSafe(deps, pid) {
  try {
    const value = deps.readProcStart(pid)
    return value === undefined ? null : value
  } catch (_) {
    return null
  }
}

function unlinkQuiet(fs, filePath) {
  try {
    fs.unlinkSync(filePath)
  } catch (_) {
    // 無くても構わない
  }
}

module.exports = { acquireLock }
