# Changelog

本项目遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## 0.1.0

首个版本。

### 新增

- 12 个 DSH 工具：`quark_send`、`quark_upload`、`quark_share`、`quark_search`、`quark_browse`、`quark_mkdir`、`quark_move`、`quark_saveas`、`quark_download`、`quark_whoami`、`quark_setup`、`quark_help`。
- `quark_send` 一次调用完成「上传 → 分享」，返回链接、提取码与有效期。
- CLI 自动发现（配置 / 环境变量 / 常见 skill 路径），缺失时返回安装指引而非抛错。
- NDJSON 解析与 `notice.text` 逐字透出。
- 错误码翻译：`14001` 自动回落网盘根目录，`32003`/`32004`/`-202`/`-403`/授权过期均给出可执行提示。
- 分享默认值与超时可在 `cordis.patch.yml` 配置。
- `npm run smoke` 离线自检、`npm run smoke:live` 真实只读联通性检查。
