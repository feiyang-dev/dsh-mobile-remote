# 文档 / Docs

本目录存放发布文档的附属资源。

## 截图（Screenshots）

README 中的 `![远程控制](./docs/assets/remote-control.png)` 需要一张**设置 → 远程控制**面板的截图。

### 如何生成

1. 启动 dsh（任意方式），打开 `http://127.0.0.1:3080`。
2. 进入 **设置 → 远程控制** 面板。
3. 截取整个面板区域，保存为 `docs/assets/remote-control.png`（建议宽度 ≥ 800px，PNG 格式）。

> 截图仅供文档展示，请勿包含敏感信息（API Key 等）。

## 发布文档（GitHub Release）

- `RELEASE_NOTES.md`：GitHub Release 正文（每次发版时更新），由 `.github/workflows/release.yml` 自动读取。
- `CHANGELOG.md`：完整的版本历史。
- `README.md` / `README.zh.md`：双语 README（仓库主页 + npm 首页）。
