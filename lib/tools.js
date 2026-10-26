/**
 * The tool surface.
 *
 * Design notes (why these tools and not a 1:1 mirror of the CLI):
 *   - `quark_send` collapses the three CLI calls a user actually wants
 *     (upload → share → copy link) into one tool call.
 *   - `fids`, `share_url`, `passcode` are propagated between tools so a model
 *     never has to re-derive them from raw JSON.
 *   - directory arguments are optional and never invented: the CLI's own
 *     default is used, and the single known CLI failure mode
 *     (`14001 upload dir blank`) is retried once against the drive root and
 *     reported in the result instead of failing the turn.
 *   - every result carries the CLI's `notice.text` verbatim when it exists.
 */

import fs from 'node:fs'
import path from 'node:path'

import {
  LOGIN_HINT,
  QuarkCliError,
  SETUP_HINT,
  cacheDir,
  cliSkillDir,
  dshHome,
  locateCli,
  runPlain,
  runProcess,
  runQuark,
} from './cli.js'
import {
  expireLabel,
  expireTypeForDays,
  formatBytes,
  formatTime,
  normalizeEntry,
  pick,
  table,
  truncate,
  urlTypeLabel,
} from './format.js'

// The host provides @deepseek-ai/dsh-tools at runtime. Outside DSH (unit tests,
// `node scripts/smoke.mjs`) a tiny compiler stand-in keeps the module loadable
// and keeps the specs shaped like the host's compiled output.
let defineToolImpl = null
try {
  const mod = await import('@deepseek-ai/dsh-tools')
  if (mod && typeof mod.defineTool === 'function') defineToolImpl = mod.defineTool
} catch {
  /* not running inside DSH */
}

function fallbackDefineTool(spec) {
  const properties = spec.parameters || {}
  const required = Object.keys(properties).filter((key) => properties[key]?.required === true)
  return {
    ...spec,
    parameters: { type: 'object', properties, ...(required.length > 0 ? { required } : {}) },
    output: { schema: spec.output?.schema, render: spec.output?.render },
  }
}

const defineTool = (spec) => {
  // Every tool in this package answers with one markdown summary, so the output
  // contract is applied centrally instead of repeated on each spec.
  const complete = { output: TEXT_OUTPUT, ...spec }
  return defineToolImpl ? defineToolImpl(complete) : fallbackDefineTool(complete)
}

const TEXT_OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      summary: { type: 'string', required: true },
    },
  },
  render: (_args, value) => [{ type: 'text', text: value.summary }],
}

export const DEFAULTS = {
  enabled: true,
  cliPath: '',
  /** 1 = 公开链接, 2 = 私密链接（提取码由服务端生成） */
  shareUrlType: 1,
  /** 分享默认有效期（天）；0 = 永久 */
  shareExpireDays: 7,
  /** 普通命令超时 */
  timeoutMs: 180000,
  /** 上传/下载超时 */
  uploadTimeoutMs: 1800000,
  /** 单次列表最多返回多少行给模型 */
  maxRows: 20,
}

function withNotices(summary, notices) {
  const texts = (notices || []).map((notice) => String(notice?.text || '').trim()).filter(Boolean)
  if (texts.length === 0) return summary
  return `${summary}\n\n---\n${texts.join('\n\n')}`
}

function assertPaths(paths) {
  const list = Array.isArray(paths) ? paths.filter((p) => typeof p === 'string' && p.trim()) : []
  if (list.length === 0) throw new QuarkCliError('paths 不能为空：请给出要上传的本地绝对路径')
  return list.map((p) => p.trim())
}

function sessionKeyOf(exec) {
  return exec?.agent?.session?.id ?? exec?.session?.id ?? exec?.agent?.id ?? 'dsh'
}

/** Parse a JSONL artifact written by the CLI. */
function readJsonl(filePath, limit) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return []
    const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter((line) => line.trim().startsWith('{'))
    const rows = []
    for (const line of lines) {
      try {
        rows.push(JSON.parse(line))
      } catch {
        /* skip malformed line */
      }
      if (rows.length >= limit) break
    }
    return rows
  } catch {
    return []
  }
}

function renderEntries(entries, headers, limit) {
  const rows = entries.slice(0, limit).map((entry) => {
    const item = normalizeEntry(entry)
    return [
      `${item.isDir ? '📁 ' : '📄 '}${truncate(item.name, 42)}`,
      item.isDir ? '—' : formatBytes(item.size),
      formatTime(item.updated) || '—',
      item.fid || '—',
    ]
  })
  return table(headers, rows)
}

export function registerQuarkTools(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...(config || {}) }
  if (!ctx?.tools || typeof ctx.tools.register !== 'function') {
    throw new Error('dsh-better-quark-drive 需要 tools 服务：请在 cordis 配置里为插件注入 tools')
  }

  const scratch = cfg.scratchDir || cacheDir()
  const maxRows = Number.isFinite(cfg.maxRows) ? cfg.maxRows : DEFAULTS.maxRows

  const call = (exec, argv, extra = {}) =>
    runQuark(argv, {
      config: cfg,
      sessionKey: sessionKeyOf(exec),
      sessionInput: extra.sessionInput ?? '',
      timeoutMs: extra.timeoutMs,
      cwd: extra.cwd,
    })

  async function uploadCore(exec, paths, parentFid) {
    const base = ['upload', ...paths]
    let res
    let dirFallback = false
    const extra = { sessionInput: '把本地文件上传到夸克网盘', timeoutMs: cfg.uploadTimeoutMs }
    try {
      res = await call(exec, parentFid ? [...base, '--parent-fid', parentFid] : base, extra)
    } catch (error) {
      const blankDir =
        error instanceof QuarkCliError &&
        String(error.code) === '14001' &&
        /upload dir/i.test(error.message) &&
        !parentFid
      if (!blankDir) throw error
      // The CLI has no default upload directory configured on this machine.
      // Root (FID 0) is the only safe fallback; the result says so explicitly.
      dirFallback = true
      res = await call(exec, [...base, '--parent-fid', '0'], extra)
    }
    const files = (res.lists || [])
      .filter((row) => row && row.code === 0 && row.data)
      .map((row) => ({
        fid: String(row.data.fileId ?? ''),
        name: String(row.data.fileName ?? ''),
        size: Number(row.data.fileSize ?? 0),
        instant: Boolean(row.data.instantUpload),
      }))
    const data = res.result?.data ?? {}
    const fids = Array.isArray(data.fids) && data.fids.length > 0 ? data.fids.map(String) : files.map((file) => file.fid)
    return {
      res,
      files,
      fids,
      dirFallback,
      fullPath: String(data.fullPath ?? ''),
      totalSize: Number(data.totalSize ?? files.reduce((sum, file) => sum + (file.size || 0), 0)),
    }
  }

  async function shareCore(exec, fids, { title, expireDays, urlType } = {}) {
    const list = (Array.isArray(fids) ? fids : [fids]).map((fid) => String(fid || '').trim()).filter(Boolean)
    if (list.length === 0) throw new QuarkCliError('请给出要分享的 fid（quark_upload / quark_search 的返回值里都有）')
    const argv = [
      'share',
      ...list,
      '--url-type',
      String(urlType ?? cfg.shareUrlType ?? 1),
      '--expired-type',
      String(expireTypeForDays(expireDays, cfg.shareExpireDays ?? 7)),
    ]
    if (title) argv.push('--title', String(title).slice(0, 80))
    const res = await call(exec, argv, { sessionInput: '生成夸克网盘分享链接', timeoutMs: cfg.timeoutMs })
    const data = res.result?.data ?? {}
    return {
      res,
      shareUrl: String(data.share_url ?? ''),
      passcode: String(data.passcode ?? ''),
      urlType: data.url_type ?? urlType ?? cfg.shareUrlType ?? 1,
      expiredType: data.expired_type ?? expireTypeForDays(expireDays, cfg.shareExpireDays ?? 7),
      fids: list,
    }
  }

  const registered = []

  // ---------------------------------------------------------------- setup ---
  registered.push(
    defineTool({
      name: 'quark_setup',
      description:
        '检查/修复夸克网盘运行环境：确认 quark-drive.cjs 是否存在、账号是否已授权，并给出登录或安装步骤。action=check 只读检查；install 会运行官方 install.sh 安装或升级 CLI（需要 bash）；login 只返回授权指引，不执行交互式登录。首次使用夸克工具或遇到“未授权/找不到 CLI”时先调用它。',
      parameters: {
        action: {
          type: 'string',
          enum: ['check', 'install', 'login'],
          description: 'check（默认）检查环境；install 运行官方安装脚本；login 输出登录指引。',
        },
      },
      timeoutMs: 300000,
      async execute(args, exec) {
        const action = String(args?.action || 'check')
        const cliPath = locateCli(cfg)
        const lines = []

        if (action === 'login') {
          return { summary: LOGIN_HINT }
        }

        if (action === 'install') {
          if (!cliPath) {
            return {
              summary: `${SETUP_HINT}\n\n当前机器上没有可直接运行的 install.sh，请先按上面第 1 步放置 skill 目录。`,
            }
          }
          const dir = cliSkillDir(cliPath)
          const script = path.join(dir, 'install.sh')
          if (!fs.existsSync(script)) {
            return { summary: `没有找到安装脚本：${script}\n可手动执行：node "${cliPath}" --help 验证 CLI 是否可用。` }
          }
          const bashCandidates = process.platform === 'win32'
            ? ['bash', 'C:\\Program Files\\Git\\bin\\bash.exe']
            : ['bash']
          let result = null
          for (const bash of bashCandidates) {
            result = await runProcess(bash, ['scripts/install.sh'], { cwd: dir, timeoutMs: 280000 })
            if (result.code === 0) break
          }
          const tail = `${result?.stdout || ''}\n${result?.stderr || ''}`
            .trim()
            .split(/\r?\n/)
            .slice(-12)
            .join('\n')
          return {
            summary: `${result && result.code === 0 ? '官方 install.sh 执行完成 ✅' : '官方 install.sh 执行失败 ❌'}\n\n\`\`\`\n${tail || '(无输出)'}\n\`\`\`\n若脚本需要交互式授权，请在终端执行：node "${cliPath}" login`,
          }
        }

        // check
        if (!cliPath) return { summary: SETUP_HINT }
        lines.push(`CLI 路径：${cliPath}`)
        try {
          const version = await runPlain(['--version'], { config: cfg, timeoutMs: 20000 })
          const text = (version.stdout || version.stderr || '').trim().split(/\r?\n/)[0]
          if (text) lines.push(`CLI 版本：${text}`)
        } catch {
          lines.push('CLI 版本：读取失败（不影响使用）')
        }
        try {
          const info = await call(exec, ['get-user-info'], { sessionInput: '检查夸克网盘授权状态', timeoutMs: 60000 })
          const vip = info.result?.data?.vipInfo ?? {}
          const capacity = Number(vip.capacity ?? 0)
          const used = Number(vip.used ?? 0)
          lines.push('授权状态：已授权 ✅')
          if (vip.vipType) lines.push(`会员：${vip.vipType}`)
          if (capacity > 0) lines.push(`容量：已用 ${formatBytes(used)} / 共 ${formatBytes(capacity)}`)
          lines.push(withNotices('', info.notices))
        } catch (error) {
          const text = error instanceof QuarkCliError ? error.toText() : String(error)
          lines.push(`授权状态：未就绪 ❌\n${text}`)
        }
        return { summary: lines.filter(Boolean).join('\n') }
      },
    }),
  )

  // --------------------------------------------------------------- whoami ---
  registered.push(
    defineTool({
      name: 'quark_whoami',
      description: '查看当前夸克网盘账号的会员类型与容量占用（get-user-info）。用户问“网盘还有多少空间/我是不是会员”时用。',
      parameters: {},
      isConcurrencySafe: () => true,
      async execute(_args, exec) {
        const res = await call(exec, ['get-user-info'], { sessionInput: '查看夸克网盘账号信息', timeoutMs: 60000 })
        const data = res.result?.data ?? {}
        const vip = data.vipInfo ?? {}
        const capacity = Number(vip.capacity ?? 0)
        const used = Number(vip.used ?? 0)
        const rows = [
          ['会员类型', vip.vipType || '普通用户'],
          ['已用容量', formatBytes(used)],
          ['总容量', capacity > 0 ? formatBytes(capacity) : '未知'],
        ]
        if (capacity > 0) rows.push(['剩余', formatBytes(Math.max(capacity - used, 0))])
        return { summary: withNotices(table(['项', '值'], rows), res.notices) }
      },
    }),
  )

  // ----------------------------------------------------------------- send ---
  registered.push(
    defineTool({
      name: 'quark_send',
      description:
        '一站式：把本地文件上传到夸克网盘并立刻生成分享链接，返回可直接点开的链接（私密链接还会返回提取码）。用户说“把这个发到夸克/用夸克发给我/传到网盘再把链接给我”时，优先用本工具，而不是先 quark_upload 再 quark_share。',
      parameters: {
        paths: {
          type: 'array',
          items: { type: 'string' },
          required: true,
          description: '要上传的本地文件或文件夹绝对路径列表（支持多个）。',
        },
        title: { type: 'string', description: '分享标题；省略时用第一个文件名。' },
        expireDays: {
          type: 'integer',
          description: '链接有效期（天）：0 永久，1、7、30、60、100、180。省略时用插件配置（默认 7 天）。',
        },
        urlType: {
          type: 'integer',
          description: '1 = 公开链接（默认），2 = 私密链接（服务端生成提取码）。',
        },
        parentFid: {
          type: 'string',
          description: '上传到哪个目录的 FID；不确定就省略（默认由 CLI 决定，必要时回落网盘根目录）。',
        },
      },
      timeoutMs: 1900000,
      async execute(args, exec) {
        const paths = assertPaths(args?.paths)
        const uploaded = await uploadCore(exec, paths, args?.parentFid)
        if (uploaded.fids.length === 0) {
          throw new QuarkCliError('上传完成但没有拿到 fid，无法分享', { hint: '重试一次，或改用 quark_upload 查看详情。' })
        }
        const title = args?.title || path.basename(paths[0])
        const shared = await shareCore(exec, uploaded.fids, {
          title,
          expireDays: args?.expireDays,
          urlType: args?.urlType,
        })
        const fileLines = uploaded.files.length
          ? uploaded.files.map((file) => `- ${file.name}（${formatBytes(file.size)}）${file.instant ? ' ⚡秒传' : ''}`)
          : paths.map((p) => `- ${path.basename(p)}`)
        const lines = [
          '已上传并生成分享链接 ✅',
          ...fileLines,
          '',
          `链接：${shared.shareUrl}`,
          shared.passcode ? `提取码：${shared.passcode}` : '',
          `链接类型：${urlTypeLabel(shared.urlType)} ｜ 有效期：${expireLabel(shared.expiredType)}`,
          `fid：${uploaded.fids.join(', ')}`,
        ]
        if (uploaded.fullPath && uploaded.fullPath.includes('/')) lines.push(`所在目录：${uploaded.fullPath}`)
        if (uploaded.dirFallback) lines.push('说明：CLI 未配置默认上传目录，本次已上传到网盘根目录。')
        return { summary: withNotices(lines.filter(Boolean).join('\n'), [...uploaded.res.notices, ...shared.res.notices]) }
      },
    }),
  )

  // --------------------------------------------------------------- upload ---
  registered.push(
    defineTool({
      name: 'quark_upload',
      description:
        '只上传，不生成分享链接。返回每个文件的 fid、大小、是否秒传。用户只要“存到网盘”时用；若要链接请用 quark_send。',
      parameters: {
        paths: {
          type: 'array',
          items: { type: 'string' },
          required: true,
          description: '要上传的本地文件或文件夹绝对路径列表。',
        },
        parentFid: { type: 'string', description: '目标目录 FID；不确定就省略。' },
      },
      timeoutMs: 1900000,
      async execute(args, exec) {
        const paths = assertPaths(args?.paths)
        const uploaded = await uploadCore(exec, paths, args?.parentFid)
        const rows = uploaded.files.map((file) => [
          `${file.instant ? '⚡ ' : ''}${truncate(file.name, 42)}`,
          formatBytes(file.size),
          file.fid || '—',
        ])
        const lines = [
          `上传完成 ✅ 共 ${uploaded.fids.length} 个`,
          uploaded.files.length ? table(['文件', '大小', 'fid'], rows) : paths.map((p) => `- ${p}`).join('\n'),
        ]
        if (uploaded.fullPath && uploaded.fullPath.includes('/')) lines.push(`所在目录：${uploaded.fullPath}`)
        if (uploaded.dirFallback) lines.push('说明：CLI 未配置默认上传目录，本次已上传到网盘根目录。')
        return { summary: withNotices(lines.join('\n'), uploaded.res.notices) }
      },
    }),
  )

  // ---------------------------------------------------------------- share ---
  registered.push(
    defineTool({
      name: 'quark_share',
      description:
        '对已在网盘里的文件生成分享链接（fid 来自 quark_upload / quark_search / quark_browse）。返回链接、提取码、有效期。',
      parameters: {
        fids: {
          type: 'array',
          items: { type: 'string' },
          required: true,
          description: '要分享的文件 FID 列表。',
        },
        title: { type: 'string', description: '分享标题。' },
        expireDays: {
          type: 'integer',
          description: '有效期（天）：0 永久，1、7、30、60、100、180；省略用默认 7 天。',
        },
        urlType: { type: 'integer', description: '1 公开（默认），2 私密（带提取码）。' },
      },
      timeoutMs: 120000,
      async execute(args, exec) {
        const shared = await shareCore(exec, args?.fids, {
          title: args?.title,
          expireDays: args?.expireDays,
          urlType: args?.urlType,
        })
        const lines = [
          '分享链接已生成 ✅',
          `链接：${shared.shareUrl}`,
          shared.passcode ? `提取码：${shared.passcode}` : '',
          `链接类型：${urlTypeLabel(shared.urlType)} ｜ 有效期：${expireLabel(shared.expiredType)}`,
          `fid：${shared.fids.join(', ')}`,
        ]
        return { summary: withNotices(lines.filter(Boolean).join('\n'), shared.res.notices) }
      },
    }),
  )

  // --------------------------------------------------------------- search ---
  registered.push(
    defineTool({
      name: 'quark_search',
      description:
        '在网盘里按关键词搜索文件（不是列目录）。返回名称、大小、更新时间和 fid 表格；fid 可直接喂给 quark_share / quark_move / quark_download。',
      parameters: {
        keyword: { type: 'string', required: true, description: '搜索关键词（≤50 字符）。' },
        searchType: {
          type: 'string',
          enum: ['mix', 'video', 'album', 'doc', 'audio', 'dir', 'package', 'other', 'app'],
          description: '搜索类型，默认 mix（全部）。',
        },
        parentFid: { type: 'string', description: '限定搜索的目录 FID；全盘搜索时省略。' },
        limit: { type: 'integer', description: '最多返回多少行，默认 15。' },
      },
      timeoutMs: 150000,
      async execute(args, exec) {
        const keyword = String(args?.keyword || '').trim()
        if (!keyword) throw new QuarkCliError('keyword 不能为空')
        const limit = Math.min(Math.max(Number(args?.limit) || 15, 1), 50)
        const argv = ['search', '--keyword', keyword.slice(0, 50), '--size', String(Math.max(limit, 20))]
        if (args?.searchType) argv.push('--search-type', String(args.searchType))
        if (args?.parentFid) argv.push('--parent-fid', String(args.parentFid))
        const res = await call(exec, argv, { sessionInput: `在夸克网盘搜索：${keyword}`, cwd: scratch, timeoutMs: cfg.timeoutMs })
        const artifact = (res.artifacts || []).find((row) => row?.data?.file_path)
        const rows = artifact ? readJsonl(artifact.data.file_path, limit) : (res.result?.data?.file_list ?? []).slice(0, limit)
        const total = Number(res.result?.data?.total ?? rows.length)
        if (rows.length === 0) {
          return { summary: withNotices(`没有搜到与「${keyword}」匹配的文件。`, res.notices) }
        }
        const body = renderEntries(rows, ['名称', '大小', '更新', 'fid'], limit)
        const suffix = total > rows.length ? `\n\n共找到 ${total} 个，以上为前 ${rows.length} 个。` : ''
        return { summary: withNotices(`关键词「${keyword}」：\n\n${body}${suffix}`, res.notices) }
      },
    }),
  )

  // --------------------------------------------------------------- browse ---
  registered.push(
    defineTool({
      name: 'quark_browse',
      description:
        '列出网盘某个目录的直接子项（不递归）。parentFid 省略时为网盘根目录（"0"）。用户说“看看我网盘里有什么/列一下这个文件夹”时用。',
      parameters: {
        parentFid: { type: 'string', description: '目录 FID，默认 "0"（根目录）。' },
        all: { type: 'boolean', description: '是否取全部子项（自动翻页），默认只取一页。' },
        limit: { type: 'integer', description: '最多返回多少行，默认 20。' },
      },
      timeoutMs: 150000,
      async execute(args, exec) {
        const limit = Math.min(Math.max(Number(args?.limit) || maxRows, 1), 100)
        const argv = ['browse', '--parent-fid', String(args?.parentFid || '0'), '--task-dir', scratch]
        if (args?.all) argv.push('--all')
        const res = await call(exec, argv, { sessionInput: '列出夸克网盘目录', timeoutMs: cfg.timeoutMs })
        const data = res.result?.data ?? {}
        const rows = readJsonl(data.file_path, limit)
        if (rows.length === 0) {
          return { summary: withNotices('该目录为空，或读取结果失败。', res.notices) }
        }
        const body = renderEntries(rows, ['名称', '大小', '更新', 'fid'], limit)
        const more = data.hasMore ? '\n\n还有更多子项（可用 all=true 取全部）。' : ''
        return {
          summary: withNotices(
            `目录 fid=${args?.parentFid || '0'} 共 ${data.count ?? rows.length} 项：\n\n${body}${more}`,
            res.notices,
          ),
        }
      },
    }),
  )

  // ---------------------------------------------------------------- mkdir ---
  registered.push(
    defineTool({
      name: 'quark_mkdir',
      description: '在网盘里新建文件夹，返回新目录信息（后续上传可用其 fid 作为 parentFid）。',
      parameters: {
        name: { type: 'string', required: true, description: '文件夹名称或相对路径，例如 "报告/2026"。' },
        parentFid: { type: 'string', description: '父目录 FID；省略则建在默认位置/根目录。' },
      },
      timeoutMs: 120000,
      async execute(args, exec) {
        const name = String(args?.name || '').trim()
        if (!name) throw new QuarkCliError('name 不能为空')
        const argv = ['create-folder', '--dir-path', name]
        if (args?.parentFid) argv.push('--parent-fid', String(args.parentFid))
        const res = await call(exec, argv, { sessionInput: `在夸克网盘新建文件夹：${name}`, timeoutMs: cfg.timeoutMs })
        const data = res.result?.data ?? {}
        const fid = String(pick(data, ['fid', 'file_id', 'fileId'], ''))
        const lines = [`文件夹已创建 ✅ ${name}`]
        if (fid) lines.push(`fid：${fid}（可作为上传的 parentFid）`)
        return { summary: withNotices(lines.join('\n'), res.notices) }
      },
    }),
  )

  // ----------------------------------------------------------------- move ---
  registered.push(
    defineTool({
      name: 'quark_move',
      description: '把一个或多个文件移动到指定目录（会改变网盘结构，执行前确认目标 fid）。',
      parameters: {
        fids: { type: 'array', items: { type: 'string' }, required: true, description: '要移动的文件 FID 列表。' },
        targetFid: { type: 'string', required: true, description: '目标目录 FID。' },
      },
      timeoutMs: 120000,
      async execute(args, exec) {
        const fids = (Array.isArray(args?.fids) ? args.fids : []).map(String).filter(Boolean)
        if (fids.length === 0) throw new QuarkCliError('fids 不能为空')
        const target = String(args?.targetFid || '').trim()
        if (!target) throw new QuarkCliError('targetFid 不能为空')
        const res = await call(exec, ['move', ...fids, '--target-fid', target], {
          sessionInput: `移动网盘文件到目录 ${target}`,
          timeoutMs: cfg.timeoutMs,
        })
        return {
          summary: withNotices(`已移动 ${fids.length} 个文件 → 目录 ${target}\n${fids.join('\n')}`, res.notices),
        }
      },
    }),
  )

  // --------------------------------------------------------------- saveas ---
  registered.push(
    defineTool({
      name: 'quark_saveas',
      description:
        '把别人分享的夸克链接转存到自己的网盘（支持带提取码）。用户发来一个 pan.quark.cn 链接说“转存/保存到我的网盘”时用。',
      parameters: {
        url: { type: 'string', required: true, description: '分享链接 URL。' },
        passcode: { type: 'string', description: '提取码（私密链接需要）。' },
        toPath: { type: 'string', description: '保存到哪个目录路径；省略则由 CLI 决定（默认根目录）。' },
        fids: {
          type: 'array',
          items: { type: 'string' },
          description: '只转存部分文件时给出分享内的 fid 列表；省略表示整个分享。',
        },
      },
      timeoutMs: 300000,
      async execute(args, exec) {
        const url = String(args?.url || '').trim()
        if (!/^https?:\/\//i.test(url)) throw new QuarkCliError('url 需要是 http(s) 开头的分享链接')
        const argv = ['saveas', '--url', url]
        const fids = (Array.isArray(args?.fids) ? args.fids : []).map(String).filter(Boolean)
        if (fids.length > 0) argv.push('--fid-list', fids.join(','))
        else argv.push('--save-all')
        if (args?.toPath) argv.push('--to-pdir-path', String(args.toPath))
        if (args?.passcode) argv.push('--passcode', String(args.passcode))
        const res = await call(exec, argv, { sessionInput: '转存夸克分享链接到我的网盘', timeoutMs: cfg.timeoutMs })
        const data = res.result?.data ?? {}
        const saved = pick(data, ['saved_count', 'successCount', 'count'], '')
        return {
          summary: withNotices(
            `转存完成 ✅${saved !== '' ? `（${saved} 个文件）` : ''}\n来源：${url}${args?.passcode ? `\n提取码：${args.passcode}` : ''}`,
            res.notices,
          ),
        }
      },
    }),
  )

  // ------------------------------------------------------------- download ---
  registered.push(
    defineTool({
      name: 'quark_download',
      description: '从网盘下载一个文件到本地目录，返回保存路径。资源较大时耗时长，注意超时设置。',
      parameters: {
        fid: { type: 'string', required: true, description: '要下载的文件 FID。' },
        outputDir: {
          type: 'string',
          description: '本地输出目录（绝对路径）；省略时用 $DSH_HOME/downloads/quark。',
        },
        overwrite: { type: 'boolean', description: '同名文件是否覆盖，默认 false（自动重命名）。' },
      },
      timeoutMs: 1900000,
      async execute(args, exec) {
        const fid = String(args?.fid || '').trim()
        if (!fid) throw new QuarkCliError('fid 不能为空')
        const outputDir = String(args?.outputDir || path.join(dshHome(), 'downloads', 'quark'))
        const argv = ['download', '--fid', fid, '--output-dir', outputDir]
        if (args?.overwrite) argv.push('--overwrite')
        const res = await call(exec, argv, {
          sessionInput: `从夸克网盘下载文件到 ${outputDir}`,
          timeoutMs: cfg.uploadTimeoutMs,
        })
        const data = res.result?.data ?? {}
        const savedPath = String(pick(data, ['file_path', 'savePath', 'path', 'localPath'], ''))
        return {
          summary: withNotices(
            `下载完成 ✅\n保存到：${savedPath || outputDir}`,
            res.notices,
          ),
        }
      },
    }),
  )

  // ----------------------------------------------------------------- help ---
  registered.push(
    defineTool({
      name: 'quark_help',
      description: '列出本插件提供的全部夸克工具与典型用法（不确定该调哪个工具时先看这个）。',
      parameters: {},
      isConcurrencySafe: () => true,
      async execute() {
        const rows = [
          ['quark_send', '本地文件 → 上传 + 分享链接（一步到位）'],
          ['quark_upload', '只上传，拿 fid'],
          ['quark_share', '已有 fid → 分享链接'],
          ['quark_search', '关键词搜索，拿 fid'],
          ['quark_browse', '列目录'],
          ['quark_mkdir', '新建文件夹'],
          ['quark_move', '移动文件'],
          ['quark_saveas', '转存别人的分享链接'],
          ['quark_download', '下载到本地'],
          ['quark_whoami', '账号/容量'],
          ['quark_setup', '环境检查、安装、登录指引'],
        ]
        const cliPath = locateCli(cfg)
        return {
          summary: [
            table(['工具', '用途'], rows),
            '',
            `CLI：${cliPath || '未找到（先跑 quark_setup）'}`,
            `默认分享：${urlTypeLabel(cfg.shareUrlType)}，${cfg.shareExpireDays === 0 ? '永久有效' : `${cfg.shareExpireDays} 天`}`,
          ].join('\n'),
        }
      },
    }),
  )

  // Register only after every spec has been built: a failed spec must not leave
  // a half-populated tool surface behind.
  for (const tool of registered) ctx.tools.register(tool)

  return { tools: registered.map((tool) => tool.name) }
}
