# Google 登录配置指南

## 功能说明

Solara 现在支持 Google OAuth 2.0 登录，每个用户的数据（播放列表、收藏列表等）都会独立保存。

## 配置步骤

### 1. 创建 Google OAuth 2.0 凭据

1. 访问 [Google Cloud Console](https://console.cloud.google.com/)
2. 创建新项目或选择现有项目
3. 启用 **Google+ API** 或 **Google Identity API**
4. 转到 **API 和服务 > 凭据**
5. 点击 **创建凭据 > OAuth 客户端 ID**
6. 选择 **Web 应用程序**
7. 配置：
   - **名称**：Solara Music Player
   - **已授权的 JavaScript 来源**：`https://your-domain.com`（你的域名）
   - **已授权的重定向 URI**：`https://your-domain.com/api/google-auth`
8. 创建后，保存 **客户端 ID** 和 **客户端密钥**

### 2. 配置 Cloudflare Pages 环境变量

在 Cloudflare Pages 项目设置中，添加以下环境变量：

- `GOOGLE_CLIENT_ID`: 你的 Google OAuth 客户端 ID
- `GOOGLE_CLIENT_SECRET`: 你的 Google OAuth 客户端密钥
- `GOOGLE_REDIRECT_URI`: `https://your-domain.com/api/google-auth`（可选，默认会自动生成）

### 3. 本地开发配置

在 `wrangler.toml` 中添加环境变量（仅用于本地开发）：

```toml
[vars]
GOOGLE_CLIENT_ID = "your-client-id"
GOOGLE_CLIENT_SECRET = "your-client-secret"
GOOGLE_REDIRECT_URI = "http://localhost:8788/api/google-auth"
```

或者使用 `.dev.vars` 文件（不会被提交到 Git）：

```
GOOGLE_CLIENT_ID=your-client-id
GOOGLE_CLIENT_SECRET=your-client-secret
GOOGLE_REDIRECT_URI=http://localhost:8788/api/google-auth
```

### 4. 数据库表结构

系统会自动创建以下表：

- `users`: 存储用户信息（用户ID、邮箱、姓名、头像等）
- `playback_store`: 存储播放列表数据（按用户ID隔离）
- `favorites_store`: 存储收藏列表数据（按用户ID隔离）

## 使用说明

1. **登录**：访问登录页面，点击"使用 Google 账号登录"按钮
2. **数据隔离**：每个 Google 账号的数据完全独立，不会互相干扰
3. **登出**：点击页面右上角的"登出"按钮

## 注意事项

- Google 登录需要 HTTPS（生产环境）
- 本地开发可以使用 HTTP，但需要配置正确的重定向 URI
- 用户数据存储在 Cloudflare D1 数据库中
- 如果未配置 Google OAuth，用户仍可使用密码登录（如果设置了 PASSWORD 环境变量）

