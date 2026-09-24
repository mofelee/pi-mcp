# 图片 URL 与模型图像输入

状态：设计提案，HTTP 图片路由和 read_image 工具尚未实现。当前已实现 TUI 图片显示、初始提示词正文和内联 HTTP 日志。遵循项目 AGENTS.md：日志查看者按本机管理员对待，原文默认折叠、点击展开，运行日志和图片缓存不落盘。

## 核心决策

一张图片作为一个 Asset，提供三种消费方式：

- 模型：MCP `content` 中的 `type: "image"` 内容块。
- 人：可直接打开的 HTTP 图片 URL。
- 本机终端：Pi 原生图像组件（Ghostty/Kitty 图形协议），直接使用缓存数据，不绕公网。

URL 是图片地址，不等于模型已经收到图片像素。不能只返回 URL 字符串并假设客户端会自动获取、显示或送给模型。服务器不额外调用一个视觉模型；仍由当前客户端连接的模型理解图像。

## 两条入口

### 本地图片 / Kimi 截图

Kimi 截图得到本地文件 → 调用现有 read → 图片内容进入 AssetStore → 同时返回 image 内容块和 Asset 元数据 → TUI 显示图片，用户可以打开 URL。

仅注册实际被工具读取/返回的图片；不扫描整个截图目录，不提供任意文件路径的静态挂载。必要时保留原图并生成展示版，避免丢失小字号文字。

### 用户给出的图片 URL

新增 `read_image({ url })`。服务器通过 HTTP(S) 获取图片，校验内容、缓存后返回与本地图片相同的格式。也支持 `read_image({ asset_id })`，两者只能提供一个。

这是显式工具能力，不让服务端自动抓取所有工具输出中的链接。对自身 Asset URL 直接查表读取，不循环请求自身 HTTP 端点。

## HTTP 接口

拟增加：

```text
GET  /images/<opaque-id>/original.<ext>?expires=<unix>&sig=<signature>
GET  /images/<opaque-id>/preview.png?expires=<unix>&sig=<signature>
HEAD /images/<opaque-id>/preview.png?expires=<unix>&sig=<signature>
```

由现有 Bun 服务的路由提供实际图片字节，Content-Type 使用经检测确认的图片类型，Content-Disposition 为 inline；设置 nosniff、Referrer-Policy: no-referrer 和 Cache-Control: private, no-store。不把整幅图片装进 HTML，也不把本机文件路径编码到 URL。

注册、按 asset_id 读取和续签走现有 OAuth 工具调用。直接图片 URL 使用短时签名，绑定资源 ID、变体和过期时间；只授予读取该图片的能力，不复用 OAuth access token，不要求浏览器另一次登录。持有链接者在有效期内可访问对应图片，默认建议 30 分钟，允许重试和重复 GET/HEAD，不使用会被预取耗尽的一次性链接。

外网使用 BASE_URL 对应的 HTTPS 地址。资源不存在或已删除返回 404，签名无效或过期返回 403；工具可为仍然存在的资源生成新链接。签名和查询参数中的凭据不进入访问日志。

## MCP 返回值

保留已有 output/details 结构，避免破坏严格的 outputSchema：

```json
{
  "content": [
    { "type": "text", "text": "Google 首页截图；原图链接见 details.images" },
    { "type": "image", "mimeType": "image/png", "data": "<base64 encoded pixels>" }
  ],
  "structuredContent": {
    "output": "Google 首页截图",
    "details": {
      "images": [{
        "id": "img_random_id",
        "url": "https://mcp.example.com/images/img_random_id/preview.png?expires=...&sig=...",
        "mimeType": "image/png",
        "width": 1242,
        "height": 1246,
        "expiresAt": "<ISO timestamp>"
      }]
    }
  }
}
```

base64 只放 image 块，不在 structuredContent / 日志中复制。可附加 MCP resource_link 供兼容客户端按需下载，但不能把资源链接当成图像输入的替代品。ChatGPT 对话框是否内联显示由客户端实现决定；必要时提供专用插件图片组件，而不是宣称 Markdown 图片链接一定会渲染。

## 实现模块

`src/assets/store.ts`：随机 ID、owner、原始 MIME、尺寸、字节数、内存 Buffer、内容哈希、过期时间；限制总内存和 TTL，淘汰不再使用的对象，重启清空。不得为日志/图片展示新建磁盘缓存或临时副本；已存在的用户源图片不属于运行日志。对外 ID 不使用内容哈希，避免推断其他用户文件。

`src/assets/fetch.ts`：URL 下载、取消信号、超时、重定向、内容长度和像素上限。默认建议单图 10 MiB、超时 10 秒、最多 3 次跳转；这些是项目默认值，不是协议限制。每次跳转重新检查目标地址；解析并固定验证过的目标 IP，阻止 DNS 重绑定和不期望的内网访问，不携带 MCP 的 OAuth 凭据到外站。需要内网图片来源时使用显式部署配置，而不是运行中弹出确认框。

`src/assets/routes.ts`：签名校验、GET/HEAD、图片响应。只能按登记的资源 ID 访问，不接受 path=/Users/...，不进行目录遍历；SVG 等主动内容默认不直接托管，先转成光栅图片或拒绝。

`src/assets/tool.ts`：read_image 工具定义；现有 read 结果也经过同一登记层。新增工具时更新服务版本和工具列表，错误同样返回匹配输出 schema 的 structuredContent。

在 HTTP 取图日志中记录 asset ID、状态码、字节数、耗时，穿插到工具时间线；不记录签名、原始图片或授权头。

## 验收

本地 read 和外部 URL 都能返回实际图像块；原图与展示图对应同一资源；签名有效/过期、HEAD、重复读取、下载取消、图片格式伪装、重定向到内网和容量清理分别测试。最后独立验证“模型能看见”和“用户界面能展示”两条链路。

## 参考

- MCP 工具结果： https://modelcontextprotocol.io/specification/2025-06-18/server/tools
- OpenAI 图像输入： https://developers.openai.com/api/docs/guides/images-vision
- Ghostty 图形协议能力： https://ghostty.org/docs/features
- ChatGPT 插件 UI： https://developers.openai.com/plugins/build/chatgpt-ui
