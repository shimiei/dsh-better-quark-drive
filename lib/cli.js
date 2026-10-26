/**
 * Quark Drive CLI bridge.
 *
 * One place that knows how to talk to the official `quarkclouddrive` CLI
 * (`scripts/quark-drive.cjs`).
 *
 * Why a bridge instead of spawning the CLI from each tool:
 *   - the CLI wants `--session-input` / `--session-id` on every call; the model
 *     should never have to invent those, so they are injected here;
 *   - the CLI speaks NDJSON (progress / list / result / artifact); a tool wants
 *     one small object;
 *   - CLI error codes are terse (`-201`, `14001`); the bridge turns them into a
 *     hint the model can act on;
 *   - some results carry `notice.text` that must be surfaced verbatim — it is
 *     collected here so every tool can render it.
 *
 * Nothing in this module reads, stores or prints credentials: the CLI owns its
 * own token file, and stderr is only used for diagnostics.
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const SKILL_DIR_NAME = 'quarkclouddrive'
const CLI_RELATIVE = path.join('scripts', 'quark-drive.cjs')
const SESSION_IDS = new Map()

/** A CLI failure with an actionable hint. */
export class QuarkCliError extends Error {
  constructor(message, options = {}) {
    super(message)
    this.name = 'QuarkCliError'
    this.code = options.code
    this.hint = options.hint ?? ''
    this.stdout = options.stdout ?? ''
    this.stderr = options.stderr ?? ''
  }

  toText() {
    const suffix = this.code === undefined ? '' : `（code ${this.code}）`
    return this.hint ? `${this.message}${suffix}\n提示：${this.hint}` : `${this.message}${suffix}`
  }
}

export const SETUP_HINT = [
  '未找到夸克网盘 CLI（quark-drive.cjs）。三种修法，任选其一：',
  '1. 安装官方 skill：把 quarkclouddrive 放到 $DSH_HOME/skills/ 或 ~/.agents/skills/，再运行 bash scripts/install.sh；',
  '2. 在本插件配置里写 cliPath，直接指向已有的 quark-drive.cjs；',
  '3. 设置环境变量 DSH_QUARK_CLI=/abs/path/to/quark-drive.cjs。',
].join('\n')

export const LOGIN_HINT = [
  '账号未授权或授权已过期。执行（把 <cli> 换成 quark-drive.cjs 的实际路径）：',
  '  node <cli> login',
  '按提示在浏览器/夸克 App 完成授权，然后重试本工具。',
].join('\n')

/** `$DSH_HOME`, falling back to `~/.dsh`. */
export function dshHome() {
  const fromEnv = process.env.DSH_HOME || process.env.DSH_HOME_DIR
  if (fromEnv && fromEnv.trim()) return fromEnv.trim()
  return path.join(os.homedir(), '.dsh')
}

/** Cache directory used for CLI scratch output (browse JSONL etc.). */
export function cacheDir() {
  const dir = path.join(dshHome(), 'cache', 'better-quark-drive')
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch {
    /* read-only home: fall back to os tmpdir below */
  }
  return fs.existsSync(dir) ? dir : os.tmpdir()
}

/**
 * The CLI only requires `{timestamp}-{random}`; we derive it from the DSH
 * session so one DSH conversation keeps one CLI session (the CLI uses it for
 * quality tracing only).
 */
export function quarkSessionId(key) {
  const k = String(key || 'dsh')
  let id = SESSION_IDS.get(k)
  if (!id) {
    const digest = createHash('sha1').update(k).digest('hex').slice(0, 6)
    id = `${Math.floor(Date.now() / 1000)}-${digest}`
    SESSION_IDS.set(k, id)
  }
  return id
}

/** Ordered list of places the CLI may live. */
export function cliCandidates(config = {}) {
  const list = []
  if (config.cliPath) list.push(config.cliPath)
  for (const envName of ['DSH_QUARK_CLI', 'QUARK_DRIVE_CLI']) {
    const value = process.env[envName]
    if (value && value.trim()) list.push(value.trim())
  }
  const home = os.homedir()
  const skillRoots = [
    path.join(dshHome(), 'skills'),
    path.join(home, '.agents', 'skills'),
    path.join(home, '.claude', 'skills'),
    path.join(home, '.config', 'dsh', 'skills'),
  ]
  for (const root of skillRoots) list.push(path.join(root, SKILL_DIR_NAME, CLI_RELATIVE))
  list.push(path.join(home, '.quarkclouddrive', 'cli', 'quark-drive.cjs'))
  return list
}

export function locateCli(config = {}) {
  for (const candidate of cliCandidates(config)) {
    try {
      if (candidate && fs.existsSync(candidate)) return candidate
    } catch {
      /* unreadable candidate: keep looking */
    }
  }
  return null
}

/** Locate the `scripts/` directory that owns the CLI (for install.sh). */
export function cliSkillDir(cliPath) {
  return cliPath ? path.dirname(path.dirname(cliPath)) : null
}

function execNode(args, { timeoutMs = 600000, cwd } = {}) {
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(process.execPath, args, {
        cwd: cwd || undefined,
        windowsHide: true,
        env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
        // stdin is closed on purpose: the CLI must never block on a prompt.
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      reject(new QuarkCliError(`无法启动夸克 CLI：${error.message}`))
      return
    }

    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn(value)
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
      finish(
        reject,
        new QuarkCliError('夸克 CLI 调用超时', {
          hint: `${Math.round(timeoutMs / 1000)} 秒内没有返回。大文件上传请调高 uploadTimeoutMs，或改用终端手动执行。`,
        }),
      )
    }, timeoutMs)

    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', (error) => finish(reject, new QuarkCliError(`夸克 CLI 启动失败：${error.message}`)))
    child.on('close', (code) => finish(resolve, { code, stdout, stderr }))
  })
}

/** Split the CLI's NDJSON stream into the pieces a tool cares about. */
export function parseNdjson(text) {
  const parsed = { result: null, lists: [], artifacts: [], progress: null, notices: [] }
  for (const line of String(text || '').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    let message
    try {
      message = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (message.type === 'result') parsed.result = message
    else if (message.type === 'list') parsed.lists.push(message)
    else if (message.type === 'artifact') parsed.artifacts.push(message)
    else if (message.type === 'progress') parsed.progress = message
    if (message.notice && message.notice.text) parsed.notices.push(message.notice)
  }
  return parsed
}

const CODE_HINTS = {
  32003: '网盘空间不足：先清理文件或扩容。',
  32004: '单个文件超过上限：压缩或分卷后再传。',
  '-201': '缺少必要参数：检查工具入参（例如 fids / keyword）。',
  '-202': '本地路径不存在：请传绝对路径。',
  '-401': '没有提供 FID。',
  '-403': '分享失败：FID 无效或文件已被删除。',
  '-405': '过期类型不合法：有效值为 1/7/30/60/100/180 天或 0（永久）。',
}

/** Turn a CLI error into something a model can actually do next. */
export function hintFor(result, argv = []) {
  const code = String(result?.code ?? '')
  const msg = String(result?.msg ?? '')
  if (code === '14001' && /upload dir/i.test(msg)) {
    return 'CLI 没有默认上传目录。传 parentFid:"0"（网盘根目录），或先 quark_mkdir 建目录再上传。'
  }
  if (/未授权|认证|授权|token|登录|login/i.test(msg)) return LOGIN_HINT
  if (CODE_HINTS[code]) return CODE_HINTS[code]
  if (argv[0] === 'share' && /invalid fid/i.test(msg)) return 'FID 不存在或属于其它账号：先用 quark_search / quark_browse 拿准确 fid。'
  return ''
}

/**
 * Run one CLI command.
 *
 * @returns {{result: object, lists: object[], artifacts: object[], notices: object[], stderr: string, cli: string, sessionId: string}}
 */
export async function runQuark(argv, options = {}) {
  const { config = {}, sessionKey, sessionInput = '', timeoutMs, cwd } = options
  const cli = options.cliPath || locateCli(config)
  if (!cli) throw new QuarkCliError('未找到夸克网盘 CLI', { hint: SETUP_HINT })

  const sessionId = quarkSessionId(sessionKey)
  const full = [...argv, '--session-input', sessionInput, '--session-id', sessionId]
  const { stdout, stderr } = await execNode([cli, ...full], {
    timeoutMs: timeoutMs ?? config.timeoutMs ?? 600000,
    cwd,
  })

  const parsed = parseNdjson(stdout)
  if (!parsed.result) {
    const tail = (stderr || stdout || '').trim().split(/\r?\n/).slice(-4).join('\n')
    throw new QuarkCliError('夸克 CLI 没有返回结果', {
      hint: tail ? `CLI 输出：\n${tail}` : 'CLI 静默退出：先跑 quark_setup(action="check") 确认环境。',
      stdout,
      stderr,
    })
  }
  if (parsed.result.code !== 0) {
    throw new QuarkCliError(parsed.result.msg || `夸克 CLI 失败（code ${parsed.result.code}）`, {
      code: parsed.result.code,
      hint: hintFor(parsed.result, argv),
      stdout,
      stderr,
    })
  }
  return { ...parsed, stderr, cli, sessionId }
}

/** Run the CLI for its side effect only (install.sh, --version, …). */
export async function runPlain(argv, options = {}) {
  const { config = {}, timeoutMs, cwd } = options
  const cli = options.cliPath || locateCli(config)
  if (!cli) throw new QuarkCliError('未找到夸克网盘 CLI', { hint: SETUP_HINT })
  return execNode([cli, ...argv], { timeoutMs: timeoutMs ?? 60000, cwd })
}

/** Execute an arbitrary program (used to shell out to bash for install.sh). */
export async function runProcess(command, args, { timeoutMs = 300000, cwd } = {}) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(command, args, { cwd: cwd || undefined, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch {
      resolve({ code: -1, stdout: '', stderr: '' })
      return
    }
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* ignore */
      }
    }, timeoutMs)
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr?.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', () => {
      clearTimeout(timer)
      resolve({ code: -1, stdout, stderr })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
  })
}
