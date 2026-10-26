# 设计说明

插件很小，但每一处取舍都是为了「模型第一次调用就成功」。这篇文档记录那些取舍。

## 1. 分层

```
lib/index.js   cordis 入口：inject ['tools']，合并配置，注册工具
lib/tools.js   12 个 defineTool 规格 + 业务编排（upload → share 的组合逻辑）
lib/cli.js     CLI 发现 / spawn / NDJSON 解析 / 错误翻译 / 会话参数注入
lib/format.js  体积、时间、表格、条目字段归一化
```

`cli.js` 不懂业务，`tools.js` 不懂进程。这样替换 CLI 版本时只动一处，加工具时也只动一处。

## 2. CLI 发现顺序

1. `config.cliPath`（显式指定，优先级最高）
2. `DSH_QUARK_CLI` / `QUARK_DRIVE_CLI` 环境变量
3. `$DSH_HOME/skills/quarkclouddrive/scripts/quark-drive.cjs`
4. `~/.agents/skills/…`、`~/.claude/skills/…`、`~/.config/dsh/skills/…`
5. `~/.quarkclouddrive/cli/quark-drive.cjs`

全部落空时返回 `SETUP_HINT`，而不是抛异常——**插件挂在 DSH 启动路径上，任何环境问题都不该让宿主起不来。**

## 3. 会话参数

CLI 要求每次调用带 `--session-input`（用户原话）与 `--session-id`（同一对话内复用）。这两项对模型是无意义的负担，因此：

- `session-input` 由工具内部按语义填一句（如「把本地文件上传到夸克网盘」），不伪造用户原话；
- `session-id` 由 DSH 会话 id 派生：`{unix 秒}-{sha1(会话 id) 前 6 位}`，进程内缓存复用。

派生而不是随机，保证同一 DSH 对话在 CLI 侧也是一个稳定会话；哈希截断保证不把宿主会话 id 直接外泄。

## 4. NDJSON → 一个对象

CLI 的 `stdout` 是多行 JSON，`type` 为 `result` / `list` / `progress` / `artifact`。桥接层把：

- 最后一条 `result` 当作业务结果；
- 所有 `list` 当作逐条明细（上传时每个文件一行）；
- `artifact.data.file_path` 当作完整结果的 JSONL 指针（搜索、目录浏览）；
- 任意 `notice.text` 收集起来，由工具附在摘要末尾。

解析对坏行容错（跳过），因此 CLI 混入日志行也不会整条失败。

## 5. 错误翻译表

| CLI 返回 | 插件给出的下一步 |
| --- | --- |
| `14001` + `upload dir blank` | 自动带 `--parent-fid 0` 重试一次，并在结果里说明「已上传到根目录」 |
| `32003` | 空间不足：清理或扩容 |
| `32004` | 单文件超限：压缩或分卷 |
| `-201` | 缺参数：检查 `fids` / `keyword` |
| `-202` | 本地路径不存在：传绝对路径 |
| `-403` / `invalid fid` | FID 无效：先 `search` / `browse` 取准确 fid |
| 含「未授权 / 登录 / token」 | 输出 `node <cli> login` 的授权步骤 |

除 `14001` 这一处已知的本机配置缺陷外，**不做静默重试**：失败要能被看见。

## 6. 目录参数策略

`parentFid` 一律选填，插件绝不猜目录。原因：猜错目录会把文件散落到用户找不到的地方，而 CLI 的默认目录语义在服务端是明确的。只有当 CLI 明说自己没有默认目录（`14001`），才回落到根目录并显式告知。

## 7. 输出契约

12 个工具统一返回 `{ summary: string }`，`render` 直出文本。好处：

- 模型读到的就是最终排版（表格对齐、单位换算已完成），不会再被要求「总结一下」；
- 输出 schema 极简，宿主校验零成本；
- 后续加字段（附件、图片）时不影响已有工具。

## 8. 不做的事

- 不实现夸克 API：签名、风控、续传都交给官方 CLI。
- 不保存凭证：不读 token 文件、不缓存 cookie。
- 不做批量组织/批量重命名的自动化编排——那属于更高层的 agent 决策，本插件只提供原子能力。
- 不在插件挂载时探测网络，保证 DSH 冷启动不因网盘不可用而变慢。

## 9. 自检

`scripts/smoke.mjs` 在 DSH 外运行时用内置 `defineTool` 兼容层（把 author spec 编译成 host 形状），所以能在任何 Node ≥ 18 上验证：

1. 插件可挂载、工具数量正确；
2. 每个 spec 名称合法、参数为对象 schema、`execute` 存在、输出契约齐全；
3. 配置归一化（`shareUrlType` / `shareExpireDays` / `maxRows`）；
4. CLI 发现结果；
5. （`--live`）一次真实只读调用，确认授权与容量读取通路。
