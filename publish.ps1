# dsh-mobile-remote 发布脚本
# 前提：能访问 github.com（必要时先配置 git 代理，例如：
#   git config --global http.proxy http://127.0.0.1:7890
#   git config --global https.proxy http://127.0.0.1:7890
# 如果 GitHub 仓库 feiyang-dev/dsh-mobile-remote 尚不存在，请先在 GitHub 网页创建（空仓库，不勾选 README）。
# 仓库 Topics 记得添加：dsh-plugin（插件市场扫描标记）。

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

Write-Host "== 1/4 校验 ==" -ForegroundColor Cyan
npm run check

Write-Host "== 2/4 创建 GitHub 远程（如已有则跳过）==" -ForegroundColor Cyan
git remote add origin https://github.com/feiyang-dev/dsh-mobile-remote.git 2>$null
git remote set-url origin https://github.com/feiyang-dev/dsh-mobile-remote.git

Write-Host "== 3/4 推送到 GitHub（含 v1.4.5 tag，触发自动发布 Actions）==" -ForegroundColor Cyan
git push -u origin master
git push origin v1.4.5

Write-Host "== 4/4 完成 ==" -ForegroundColor Green
Write-Host "推送完成！GitHub Actions 将自动执行：npm run check → npm publish → 生成 Release(v1.4.5)"
Write-Host ""
Write-Host "若 Actions 需要 NPM_TOKEN，请到仓库 Settings → Secrets and variables → Actions 添加："
Write-Host "  NPM_TOKEN = npm 自动化 token（需 publish 权限）"
Write-Host "若未配置 NPM_TOKEN，可手动在 Actions 页面触发，或自行执行 npm publish（本机已登录）。"
