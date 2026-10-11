'use strict'

const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { MAX_ENTRIES, makeKey, loadNotified, hasNotified, recordNotified } = require('../lib/notified')

// 実 fs に委譲しつつ、overrides で指定した関数だけ差し替える偽 fs
// calls には書込み・rename・unlink・mkdir の呼出し引数が記録される
function fakeFs(overrides = {}) {
  const base = {
    readFileSync: (...a) => fs.readFileSync(...a),
    writeFileSync: (...a) => fs.writeFileSync(...a),
    renameSync: (...a) => fs.renameSync(...a),
    mkdirSync: (...a) => fs.mkdirSync(...a),
    unlinkSync: (...a) => fs.unlinkSync(...a),
  }
  const calls = { writeFileSync: [], renameSync: [], unlinkSync: [], mkdirSync: [] }
  const wrapped = {}
  for (const name of Object.keys(base)) {
    wrapped[name] = (...args) => {
      if (calls[name]) calls[name].push(args)
      if (overrides[name]) return overrides[name](...args)
      return base[name](...args)
    }
  }
  return { fs: wrapped, calls }
}

const fail = (msg) => () => {
  throw new Error(msg)
}

let dir
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notified-test-'))
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

const fileIn = (...p) => path.join(dir, ...p)
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))

describe('makeKey', () => {
  it('current|audited|latest の形式で作る', () => {
    assert.strictEqual(makeKey('1.0.0', '0.9.0', '1.1.0'), '1.0.0|0.9.0|1.1.0')
  })
})

describe('loadNotified', () => {
  it('ファイルが無ければ []', () => {
    assert.deepStrictEqual(loadNotified(fileIn('none')), [])
  })

  it('壊れた JSON なら []', () => {
    const file = fileIn('broken')
    fs.writeFileSync(file, '{not json')
    assert.deepStrictEqual(loadNotified(file), [])
  })

  it('配列でない JSON なら []', () => {
    const obj = fileIn('object')
    fs.writeFileSync(obj, '{"a":1}')
    assert.deepStrictEqual(loadNotified(obj), [])

    const str = fileIn('string')
    fs.writeFileSync(str, '"a|b|c"')
    assert.deepStrictEqual(loadNotified(str), [])
  })

  it('文字列以外の要素は除外する', () => {
    const file = fileIn('mixed')
    fs.writeFileSync(file, JSON.stringify(['a|b|c', 1, null, {}, ['x'], 'd|e|f']))
    assert.deepStrictEqual(loadNotified(file), ['a|b|c', 'd|e|f'])
  })
})

describe('hasNotified', () => {
  it('含まれていれば true、含まれなければ false', () => {
    assert.strictEqual(hasNotified(['a', 'b'], 'b'), true)
    assert.strictEqual(hasNotified(['a', 'b'], 'c'), false)
    assert.strictEqual(hasNotified([], 'a'), false)
  })
})

describe('recordNotified', () => {
  it('ファイルが無ければ新規作成して true', () => {
    const file = fileIn('notified')
    assert.strictEqual(recordNotified(file, 'k1', fs, { pid: 1 }), true)
    assert.deepStrictEqual(readJson(file), ['k1'])
  })

  it('同じ key の 2 回目は true で内容は変わらず、書込みもしない', () => {
    const file = fileIn('notified')
    assert.strictEqual(recordNotified(file, 'k1', fs, { pid: 1 }), true)

    const { fs: spy, calls } = fakeFs()
    assert.strictEqual(recordNotified(file, 'k1', spy, { pid: 1 }), true)
    assert.strictEqual(calls.writeFileSync.length, 0)
    assert.strictEqual(calls.renameSync.length, 0)
    assert.deepStrictEqual(readJson(file), ['k1'])
  })

  it('別の key は追加される', () => {
    const file = fileIn('notified')
    recordNotified(file, 'k1', fs, { pid: 1 })
    assert.strictEqual(recordNotified(file, 'k2', fs, { pid: 1 }), true)
    assert.deepStrictEqual(readJson(file), ['k1', 'k2'])
  })
})

describe('MAX_ENTRIES の上限', () => {
  it('MAX_ENTRIES は 50', () => {
    assert.strictEqual(MAX_ENTRIES, 50)
  })

  it('51 件目を記録すると最古が削除され 50 件に保たれる', () => {
    const file = fileIn('notified')
    for (let i = 0; i <= MAX_ENTRIES; i++) {
      assert.strictEqual(recordNotified(file, 'k' + i, fs, { pid: 1 }), true)
    }
    const list = readJson(file)
    assert.strictEqual(list.length, 50)
    assert.strictEqual(list[0], 'k1')
    assert.strictEqual(list[49], 'k50')
    assert.strictEqual(list.includes('k0'), false)
  })
})

describe('原子的な書込み', () => {
  it('一時ファイルへ書いてから rename し、最終的に file だけが残る', () => {
    const file = fileIn('notified')
    const { fs: spy, calls } = fakeFs()
    assert.strictEqual(recordNotified(file, 'k1', spy, { pid: 42 }), true)

    const tmp = file + '.42.tmp'
    assert.strictEqual(calls.writeFileSync.length, 1)
    assert.strictEqual(calls.writeFileSync[0][0], tmp)
    assert.deepStrictEqual(calls.renameSync, [[tmp, file]])
    assert.deepStrictEqual(fs.readdirSync(dir), ['notified'])
    assert.deepStrictEqual(readJson(file), ['k1'])
  })
})

describe('書込み失敗時', () => {
  it('writeFileSync が例外なら false、元のファイルは変わらず、一時ファイルの unlink を試みる', () => {
    const file = fileIn('notified')
    fs.writeFileSync(file, JSON.stringify(['old']))
    const { fs: spy, calls } = fakeFs({ writeFileSync: fail('ENOSPC (テスト)') })

    assert.strictEqual(recordNotified(file, 'k1', spy, { pid: 7 }), false)
    assert.deepStrictEqual(readJson(file), ['old'])
    assert.strictEqual(calls.unlinkSync.length, 1)
    assert.strictEqual(calls.unlinkSync[0][0], file + '.7.tmp')
  })

  it('renameSync が例外なら false、元のファイルは変わらず、一時ファイルを削除する', () => {
    const file = fileIn('notified')
    fs.writeFileSync(file, JSON.stringify(['old']))
    // unlink は実 fs に委譲するので、書かれた一時ファイルが実際に消えることも確認できる
    const { fs: spy, calls } = fakeFs({ renameSync: fail('EACCES (テスト)') })

    assert.strictEqual(recordNotified(file, 'k1', spy, { pid: 7 }), false)
    assert.deepStrictEqual(readJson(file), ['old'])
    assert.strictEqual(calls.unlinkSync.length, 1)
    assert.strictEqual(calls.unlinkSync[0][0], file + '.7.tmp')
    assert.deepStrictEqual(fs.readdirSync(dir), ['notified'])
  })
})

describe('ディレクトリの作成', () => {
  it('ディレクトリが無ければ作成されて記録できる', () => {
    const file = fileIn('a', 'b', 'notified')
    assert.strictEqual(recordNotified(file, 'k', fs, { pid: 1 }), true)
    assert.deepStrictEqual(readJson(file), ['k'])
  })

  it('mkdirSync が例外なら false で、書込みは行わない', () => {
    const file = fileIn('x', 'notified')
    const { fs: spy, calls } = fakeFs({ mkdirSync: fail('EACCES (テスト)') })

    assert.strictEqual(recordNotified(file, 'k', spy, { pid: 1 }), false)
    assert.strictEqual(calls.writeFileSync.length, 0)
    assert.strictEqual(fs.existsSync(file), false)
  })
})
