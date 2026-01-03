# Solara 本地开发启动脚本
Write-Host "正在启动 Solara 开发服务器..." -ForegroundColor Green
Write-Host "服务器将在 http://localhost:8788 启动" -ForegroundColor Yellow
Write-Host "按 Ctrl+C 停止服务器" -ForegroundColor Gray
Write-Host ""

npx wrangler pages dev --port 8788



