# pi-mcp

把 [pi coding agent](https://pi.dev) 的能力通过 MCP 暴露出去：一个支持 OAuth 2.1 的 MCP Server（Bun + `@modelcontextprotocol/server`），用于接入 ChatGPT 的 MCP Connector，也可以直接给其它 MCP 客户端用。

- MCP 端点：`https://mcp.example.com/mcp`（根路径 `https://mcp.example.com` 也接受）
- 自己同时充当 **Authorization Server** 和 **Resource Server**
- 支持 **DCR（动态客户端注册） + Authorization Code + PKCE S256**
- access token 是 RS256 JWT，`aud` 绑定 RFC 8707 `resource`
- 授权前需要 **密码登录**（session 存在 HttpOnly cookie 里）
- 实现了 ChatGPT 连接器要求的 **tool 级 OAuth 信号**（`securitySchemes` + `_meta["mcp/www_authenticate"]`）
- **暴露 pi 的经典工具**：`read`、`bash`、`edit`、`write`、`grep`（可配置），直接复用 pi 自己的工具实现
- **提供一个初始提示词工具 `pi_initial_prompt`**：返回 pi 风格的 system prompt，包含工作目录、系统、时间、可用工具，以及启动时在本机动态发现的 skill 目录（只给名称/描述/路径，不加载正文）

## 工具调用 TUI

交互终端默认进入 **Pi 风格的工具监控界面**：不创建聊天输入框或模型会话。复用 `@earendil-works/pi-tui` 的 `TuiAltScreen`、`ScrollView`、原生搜索，以及 coding-agent 的 `ToolExecutionComponent`。文件路径、命令、状态、耗时、调用 ID 和输出显示在对应卡片里；HTTP 请求日志按发生顺序穿插在卡片之间，`Ctrl+G` 仍可查看包含 OAuth 等事件的全部服务日志。工具卡片固定在开始位置，运行中的输出原地更新，不因刷新改变排序。完整输入、输出和图片默认折叠，点击或 Enter 展开原始内容；`bash` 折叠卡片额外显示命令预览及字符数，预览最多 160 个 Unicode 码点（含省略号），最多取前三行并用 `↵` 压成单行，超长以 `…` 截断。不按敏感文件名、密码、token 或私钥模式隐藏正文。

`write [写入]` 为青色、`edit [编辑]` 为黄色、`bash [命令]` 为紫色；颜色只标识操作类别，不增加逐次确认、不改变 MCP 工具的权限元数据。`NO_COLOR=1` 关闭这些新增颜色，仍保留文字标签。`pi_initial_prompt` 的正文与其他文本一样可以展开、搜索和在任务日志中查看，不再替换成占位文字。

```bash
bun run tui:demo     # 独立演示；不启动服务、不执行 shell、不读取项目文件
bun run start:tui    # 启动 MCP 服务及交互界面（先停止同端口的旧进程）
bun run start:plain  # 启动服务，仅输出原有文本日志
bun run start       # 自动选择；dev 和编译后的可执行文件同样支持
```

| 快捷键 | 作用 |
| --- | --- |
| `↑` / `↓` | 选择工具；在日志视图中逐行滚动 |
| `Enter` | 展开 / 收起当前工具；也支持鼠标点击卡片 |
| `Ctrl+O` | 展开 / 收起全部工具 |
| `Ctrl+F` / `Ctrl+Shift+F` | 打开 Pi 原生搜索；搜索时临时展开卡片，关闭后恢复 |
| `Enter` / `Shift+Enter`（搜索中） | 下一个 / 上一个匹配；`Esc` 关闭搜索 |
| `Ctrl+L` | 查看当前任务的实时日志，运行中即可打开 |
| `Ctrl+R` | 跳到下一个运行中的任务并打开日志，支持并发任务 |
| `Ctrl+G` | 查看最近的 HTTP / OAuth / 服务日志；搜索中该键是下一个匹配 |
| `PgUp` / `PgDn`、鼠标滚轮 | 滚动当前视图 |
| `[` / `]`（任务日志中） | 查看保留在内存中的上一页 / 下一页 |
| `Ctrl+End` | 返回最新输出，恢复跟随 |
| `Esc` | 从日志视图返回工具列表；搜索打开时先关闭搜索 |
| `Ctrl+C` | 退出服务；有运行中任务时需在 2 秒内再次按下；有选中文本时先复制 |

配置项：

```dotenv
LOG_UI=auto             # auto / tui / plain；无 TTY 或 TERM=dumb 时始终回退普通日志
LOG_TUI_HISTORY=200      # 保留已完成任务数（1–2000），不淘汰运行中任务
LOG_TUI_THEME=dark       # dark / light，或 Pi 已安装的自定义主题
LOG_TUI_IMAGES=1         # 展开卡片时显示图片；0 关闭图片缓存/显示
LOG_TUI_OUTPUT_CHARS=1048576  # 单次调用的输入/输出各最多保留约 1 Mi 字符（4 Ki–4 Mi）
```

CLI 的 `--tui` / `--no-tui` 覆盖 `LOG_UI`。`LOG_LEVEL` 与 `LOG_REQUESTS` 控制普通日志、内联 HTTP 行和服务日志视图，不隐藏工具卡片。`tmux:attach` 可操作完整界面，`tmux:logs` 只能看到当前画面；管道、systemd 等非交互环境继续使用文本日志。

**纯内存日志：** 本地日志查看者按本机管理员对待，不设置逐次查看审批。历史、原始工具输入/输出和图片缓存只存在有界进程内存，重启后不恢复。默认保留 200 个已完成任务；单次调用的输入和输出各最多约 1 Mi 字符，超限丢弃最早内容并标记，不溢写文件。`Ctrl+L` 查看内存日志，`[` / `]` 翻页（每页 64 Ki 字符），`Ctrl+End` 跟随最新输出。搜索覆盖当前保留内容，日志视图中搜索当前页。HTTP / 服务日志保留最近 500 条。

`bash` 仍复用 Pi 的 shell 启动、超时和进程树取消，但改用内存输出收集器，不再创建 `pi-bash-*.log` 等临时日志。模型侧响应仍限制为最后 2000 行 / 50 KiB，本地 TUI 使用独立的更大内存快照。`PI_TUI_WRITE_LOG` 也不会生成画面日志；仅使用不写调试/崩溃转储的全屏渲染路径。

**图片：** `read` 复用 Pi 的图片读取与处理逻辑，返回说明文字和独立的 MCP `image` 内容块（`mimeType` + base64 `data`）；`structuredContent.output` 只保留说明文字，不重复图片编码。图片可以按默认策略转换/缩放，处理失败时会返回省略图片的说明，不能仅凭说明文字判断模型已收到图像。模型侧图片返回不依赖本地 TUI 是否展开或开启图片显示。工具返回的图片经独立缓存交给 Pi 原生组件渲染；Ghostty/Kitty 等支持图像的终端可直接展示。默认依赖 Pi 的终端能力检测；Pi 当前在 tmux 下保守关闭图片，直接在 Ghostty 运行可避免这层限制。缓存按 base64 编码长度限制为每次调用 8 MiB、全局 32 MiB，任务淘汰时释放；不支持的格式或超限图片仅保留数量，不打印编码文本。图片 URL 挂载与远程 URL 读取仍是设计提案，见 `docs/image-assets.md`。

**显示与持久化边界：** 只过滤会操作终端的控制序列，不替换可见文字。`.env`、凭据、私钥、初始提示词与其他文件一视同仁：默认折叠，展开后原样显示保留的内容。图片只走图形通道，不转成 base64 文本。旧 `LOG_TOOL_PREVIEW_CHARS` 不再控制 TUI 内容保留或展开，也不会关闭 `bash` 的独立命令预览；其余正文仍只在展开后显示。

“日志不落盘”不改变用户明确要求的文件写入、源文件本身或 OAuth 状态持久化，也不删除旧版本留下的日志。外部 shell 重定向、tee、tmux 录制、systemd/journald、终端录屏和系统交换内存不受应用控制；本项目不自动启用这些持久化。

实现位于 `src/monitor/`；测试包含状态管理、隐私、分页、真实 bash 流式输出、终端输入、搜索、缩放及终端恢复：`bun run test`。

## 普通日志

在普通日志模式下，请求与 OAuth/MCP 关键事件会逐行输出，方便排查。

```
10:34:45.394 INFO  http   POST   401    2ms /mcp ip=1.2.3.4 ua=Bun/1.4.2
10:34:46.269 INFO  oauth  收到授权请求 client=flow-test user=user_123 scope=mcp pkce=S256
10:34:46.696 INFO  oauth  签发 access token user=user_123 scope=mcp ttl=3600s refresh=yes
10:34:47.039 INFO  http   POST   200   41ms /mcp ip=1.2.3.4 ua=... user=user_123 scopes=mcp mcp=initialize
10:34:47.416 INFO  mcp    tools/call read user=user_123 ms=0 path=src/example.ts offset=10 limit=20 outputChars=37
10:34:47.500 INFO  mcp    tools/call bash [命令] user=user_123 ms=38 command="bun run typecheck" commandChars=17 outputChars=15
10:34:47.550 INFO  mcp    tools/call read user=user_123 ms=0 path=.env offset=1 outputChars=120
10:34:47.620 WARN  mcp    拒绝未授权调用 reason=pi_initial_prompt: 缺少 access token
```

| 配置 | 作用 |
| --- | --- |
| `LOG_LEVEL=info` | 默认级别，普通工具日志包含路径、数量、耗时、输出长度和 bash 命令预览；完整正文在 TUI 中展开 |
| `LOG_LEVEL=debug` | 额外输出 `tools/list`、redirect_uris 等；不转储完整工具参数和结果 |
| `LOG_TUI_OUTPUT_CHARS=1048576` | 内存输入/输出的保留上限，不涉及磁盘文件 |
| `LOG_LEVEL=warn` | 只看异常（拒绝、登录失败、未授权调用） |
| `LOG_REQUESTS=0` | 关掉每个 HTTP 请求一行，只留 OAuth/MCP 事件 |
| `NO_COLOR=1` | 关闭 ANSI 颜色 |

普通日志用于查看元数据与 bash 命令预览，命令采用与折叠卡片相同的默认 160 码点/前三行截断规则；不将文件正文、超长命令全文或图片数据平铺到 stdout。完整的已保留参数（包含写入正文与 edit 前后文本）、输出、错误信息和初始提示词均在内存 TUI 中点击展开，不做敏感文件分类。HTTP 行保持短摘要；所有日志函数都没有文件持久化后端。

看日志：`bun run tmux:logs`（或直接 `bun run tmux:attach`）。日志单元测试：`bun run test`（不连接服务、不读取真实凭据）。

## 快速开始

```bash
bun install
bun run start     # 或 bun run dev（热重载）
```

### 默认配置

不设任何环境变量也能跑，用于本地开发的默认值：

```dotenv
BASE_URL=http://localhost:3000
PORT=3000
LOGIN_PASSWORD=（未设置 → 内置 pi-mcp，属于弱密码，会拒绝启动）
LOG_LEVEL=info
LOG_REQUESTS=1
OAUTH_AUTO_APPROVE=0
```

源码里不再写死任何真实域名。公网部署必须通过内嵌配置、启动目录 `.env` 或环境变量显式声明自己的 `https://` 地址，且 `LOGIN_PASSWORD` 必须满足强度要求，否则进程拒绝启动。

应用启动时由 Bun 加载**启动目录**的 `.env`（包括 Bun 支持的 `.env.local` / `.env.<NODE_ENV>`）。编译版还会携带构建时的 `.env`，作为缺省配置：

**显式环境变量 > 启动目录的 dotenv 配置 > 构建时内嵌配置 > 程序内置默认值。**

源码运行不含内嵌配置。本地开发时把 `.env` 里的 `BASE_URL` 改成 `http://localhost:3000` 即可。

## 打包

把整个程序打包成**单文件可执行程序**（Bun `--compile`），目标机器不需要 Node/Bun：

```bash
bun run build                                  # 当前平台 → dist/，默认内嵌项目根目录 .env
bun run build -- --embed-env=/path/to/my.env    # 改为内嵌指定文件（不存在时报错）
bun run build -- --no-embed-env                # 不内嵌配置，适合公开分发
bun run build -- --outdir=/tmp/pi-mcp-build     # 独立构建目录，不覆盖正在运行的 dist/
bun run build -- --target=bun-linux-x64         # 交叉编译（含 linux-arm64、windows-x64 等）
bun run build:tar                               # 额外产出 dist/pi-mcp-<platform>.tar.gz
bun run build:run                               # 在项目目录启动已有产物，不再先 cd dist
```

构建只读取选定 `.env` 的内容，不把构建 shell 的其它环境变量或 `.env.local` 一并嵌入；没有项目根目录 `.env` 时仍可构建。解析支持注释、`export`、引号、空值和多行值；`$VAR` / `${VAR}` 保持字面值，不在构建机器上展开。需要变量展开时，请在内嵌文件里写入完整值，或通过运行时配置提供。

内嵌配置在业务模块和 Pi 初始化之前加载，只补齐缺失值，保留运行时显式设置的空字符串，不改 `process.cwd()`。修改内嵌配置后需要重新构建。**内嵌不是加密：含密码、token 的二进制和压缩包应按凭据文件保管，不能公开分发。** 构建不会输出配置值、写含密钥的生成源码或通过编译命令行参数传递它们。

产物目录 `dist/`（迁移时保留程序旁的资源；目前并非把所有资源都嵌进一个文件）：

| 文件 | 说明 |
| --- | --- |
| `pi-mcp` | 包含 Bun 运行时和内嵌配置的可执行程序（Windows 下为 `pi-mcp.exe`） |
| `photon_rs_bg.wasm` | 图片缩放用的 wasm，**必须与可执行文件同目录** |
| `pi-runtime/` | pi 自带的 `package.json` / `README.md` / `docs/` / `examples/` 及 TUI 所需的 `theme/`；初始提示词的 `<pi_docs>` 会指向这里 |
| `.env` | 不再自动生成；已有文件保持不变，仅从该目录启动时覆盖内嵌配置 |
| `.env.example` | 完整配置模板 |
| `README.md` | 本说明 |

> `pi-runtime/` 通过 `src/pi/runtime-dir.ts` 在 pi 模块加载前设置 `PI_PACKAGE_DIR` 来定位，
> 这样编译后的 `<pi_docs>` 路径和 pi 版本号仍然正确（否则会退化成 `dist/README.md`、`0.0.0`）。

### 部署

**工作目录取进程启动时的 cwd**，所以不要在 `dist/` 里启动后再去干活，而是：

```bash
# 方式一：直接到目标工作目录启动
cd /path/to/workspace
/path/to/dist/pi-mcp

# 方式二：固定工作目录，用环境变量覆盖
PI_MCP_CWD=/path/to/workspace /path/to/dist/pi-mcp
```

不需要在每个工作目录复制 `.env`：没有本地配置时会使用内嵌值。需要覆盖时，在**启动目录**放 `.env`，或通过 shell / systemd / tmux 注入环境变量。不会回到源码目录或可执行文件目录寻找 `.env`，也不会为了读取配置而切换工作目录。

`read`、`write`、`edit`、`grep`、`bash` 的相对路径，以及项目 `AGENTS.md` / skill 的发现，都使用启动时确定的工作目录。`PI_MCP_CWD` 是显式覆盖选项（支持 `~`）；要保持“在哪启动就在哪工作”，不要在内嵌配置中设置固定的 `PI_MCP_CWD`。该选项只改变工具工作目录，dotenv 仍从进程启动目录加载。

### 全局共享 OAuth 状态

**同一操作系统用户默认共用 `~/.pi-mcp/`，与启动项目、软链接和程序安装位置无关：**

```text
~/.pi-mcp/
├── .oauth-jwk.json     # 签名私钥：用于 access token 和登录 cookie
└── .oauth-store.json   # 动态注册客户端和 refresh token
```

密钥只在首次需要签名/验签或访问 JWKS 时生成，后续读取已有文件；单纯启动或 `/health` 不会生成新密钥。客户端注册或刷新授权等状态变更时写入 store。父目录按需自动创建，新建目录在 POSIX 下使用 `0700`，新建状态文件使用 `0600`。这些是持久化授权状态，不是日志，不会因关闭服务而删除。

从 A 项目停止服务后，到 B 项目启动同一个服务，文件工具和项目上下文切换到 B，授权身份仍保持不变。只要运行用户、状态路径及 `BASE_URL` 不变，并且凭据未过期或撤销，就不需要仅因换项目重新授权。用户主目录在运行机器上确定，不会把构建机器的绝对路径写死进去。

通常无需设置任何路径。`PI_MCP_STATE_DIR` 可改整个状态目录，`OAUTH_JWK_FILE` / `OAUTH_STORE_FILE` 可分别覆盖文件位置（优先级更高，支持 `~`）。显式相对路径仍按启动 cwd 解析，因此不要在内嵌配置里保留旧的 `OAUTH_JWK_FILE=.oauth-jwk.json` / `OAUTH_STORE_FILE=.oauth-store.json`，否则仍会回到每项目一份。`OAUTH_JWK` 直接提供私钥的优先级保持最高。

**旧版迁移：** 停止旧服务后，将旧运行目录里的 `.oauth-jwk.json` 和 `.oauth-store.json` 作为一组复制到 `~/.pi-mcp/`，保留原文件作备份；不要覆盖已有的全局身份，也不要混合不同服务的两份状态。程序不会自动导入任意项目内遗留的凭据。只迁移私钥不足以保留已注册客户端和 refresh token。

**分发与多实例：** 状态文件不自动嵌入二进制或收入 tar 包，不应随程序发给其他用户；内嵌 `.env` 不会迁移现有 OAuth 状态。这里的“全局”是同一用户顺序运行同一服务，不代表 JSON 文件支持多个进程同时写入。独立服务使用不同的 `PI_MCP_STATE_DIR`；多实例共享服务需要数据库等并发安全的存储。

例如通过 systemd 指定外部配置：

```ini
# /etc/systemd/system/pi-mcp.service
[Service]
WorkingDirectory=/path/to/workspace
EnvironmentFile=/etc/pi-mcp.env
ExecStart=/opt/pi-mcp/pi-mcp
Restart=always
```

### 跨目录构建回归

`bun test tests/env.test.ts tests/state.test.ts tests/build.test.ts` 使用虚构配置与隔离的用户目录构建真实二进制，在两个独立临时工作目录验证内嵌密码登录、OAuth/MCP、相对路径读写与 bash、项目上下文 / skill、图片读取、本地 `.env` 覆盖、shell 覆盖、`PI_MCP_CWD` 和符号链接启动。跨项目时只授权一次，验证旧 access token、登录 cookie、注册客户端和 refresh token 都能继续使用，且项目目录不生成 OAuth 状态。另测全局路径、权限、显式覆盖、独立状态目录和环境变量私钥优先级，并检查不内嵌模式与 tar 的状态文件排除。测试删除构建用的 `.env` 后再启动，不读取真实凭据，输出只存在有界内存。

### 在 tmux 里跑测试服务器

```bash
bun run tmux:start     # 后台启动，会话名 pi-mcp，watch 模式
bun run tmux:attach    # 接管（Ctrl-b d 脱离）
bun run tmux:logs      # 不进 tmux 直接看输出
bun run tmux:restart   # 重启（改完代码想手动刷新时）
bun run tmux:stop      # 停止
```

> `bun --watch` 会在源文件变更时自动重启，所以大多数情况下改完代码不用手动重启。

服务启动后：

```
MCP server  : https://mcp.example.com/mcp
Discovery   : https://mcp.example.com/.well-known/oauth-protected-resource/mcp
Issuer      : https://mcp.example.com
```

`.env` 里配置 `BASE_URL`（必须是对外可访问的 **https** 地址，仅本机回环可用 http）和 `LOGIN_PASSWORD`，其余可选项见 `.env.example`。

### 安全强制（构建与启动都会校验）

`BASE_URL` 同时充当 OAuth issuer，而登录后的 session 可以直接调用 `bash` / `read` / `write` / `edit`。因此以下两项在 **`bun run build` 和进程启动时都会检查**，不满足就立即退出（非 0），不会带病上线：

| 检查 | 规则 | 放行开关（仅本地/内网） |
| --- | --- | --- |
| `BASE_URL` | 公网地址必须 `https://`；仅 `localhost` / `127.0.0.1` / `::1` 可用 `http://` | `PI_MCP_ALLOW_INSECURE_BASE_URL=1` |
| `LOGIN_PASSWORD` | 至少 12 位，且覆盖小写 / 大写 / 数字 / 符号中至少 3 类；不在常见弱密码清单 | `PI_MCP_ALLOW_WEAK_PASSWORD=1` |

弱密码检查覆盖内置默认值 `pi-mcp`：没有任何配置直接启动会被拒绝，避免“默认密码上线”。构建时若内嵌的 `LOGIN_PASSWORD` 过弱，或内嵌的 `BASE_URL` 是公网明文 `http`，构建直接停止并给出原因，不产出二进制。放行开关只应出现在本地开发或内网/隧道调试，不要写进生产配置。

### 登录密码

授权流程会先要求登录：

```dotenv
LOGIN_PASSWORD=your-strong-password
```

- 未登录时访问 `/oauth/authorize` 会跳转到 `/login?next=…`，登录后自动回到授权页。
- 登录状态保存在 `mcp_session` cookie（RS256 签名的 JWT、`HttpOnly`、`SameSite=Lax`，HTTPS 下带 `Secure`），默认有效期 7 天，可用 `SESSION_TTL` 调整。
- 访问 `/logout` 退出登录。
- 未设置 `LOGIN_PASSWORD` 时会使用内置默认密码 `pi-mcp`，它属于弱密码，服务会**拒绝启动**并在日志中给出原因与修法。上线前必须设置满足上表强度要求的密码；生成方式：`openssl rand -base64 24`。

> 这是「单密码换一个用户」的演示实现：任何知道密码的人都是同一个用户（`OAUTH_DEMO_USER_ID`）。需要区分用户请接真实账号体系。

## 路由

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/.well-known/oauth-protected-resource/mcp` | RFC 9728 受保护资源元数据 |
| GET | `/.well-known/oauth-protected-resource` | 同上（无路径兼容版） |
| GET | `/.well-known/oauth-authorization-server` | RFC 8414 授权服务器元数据 |
| GET | `/.well-known/openid-configuration` | OIDC Discovery（ChatGPT 会探测） |
| GET | `/.well-known/jwks.json` | 签名公钥（仅 kty/n/e/use/alg/kid） |
| GET | `/oauth/authorize` | 授权入口（校验 PKCE / resource，展示 consent） |
| POST | `/oauth/consent` | consent 提交（allow / deny） |
| POST | `/oauth/token` | `authorization_code` / `refresh_token` 换 token |
| POST | `/oauth/register` | 动态客户端注册 |
| POST | `/oauth/revoke` | 撤销 refresh token |
| GET/POST | `/login` | 密码登录（GET 表单 / POST 校验） |
| GET | `/logout` | 退出登录并清除 session |
| POST | `/mcp` | MCP 端点（规范地址） |
| POST | `/` | MCP 端点（兼容：连接器 URL 漏写 `/mcp` 时） |
| GET | `/health` | 健康检查 |

## 在 ChatGPT 里接入

1. ChatGPT → Settings → Connectors → Advanced → **Add custom connector**
2. URL 填 `https://mcp.example.com/mcp`
   > 漏写 `/mcp` 也能工作（服务器在根路径同样提供 MCP），但建议填完整。
   > 日志里出现 `POST 404 /` 就是这里没带 `/mcp`。
3. ChatGPT 先拿 discovery 文档，自动注册客户端并发起 PKCE 授权
4. 浏览器打开登录页，**输入 `LOGIN_PASSWORD`**
5. 登录后进入授权页，点「允许」
6. 完成后工具列表会出现 `pi_initial_prompt`、`read`、`bash`、`edit`、`write`、`grep`（以及 `whoami`）

若页面显示 **“No app tools available yet”**：
- 看日志确认有没有 `ua=openai-mcp/...` 的 `tools/list` 请求。没有则连接器没连上（URL / 网络）。
- 若日志里是 `POST 404 /`，说明 URL 漏了 `/mcp`（现已兼容，但可改成完整地址）。
- 改了工具或认证后，在连接器页面点 **Refresh**；必要时删掉连接重新添加。

> ChatGPT 需要能公网访问该地址，且必须是 HTTPS（本地调试可用 `localhost`）。

### 工具列表不更新？（只看到旧的 `whoami` / `echo`）

ChatGPT 连接器会在连接时**快照一次工具列表并缓存**。服务端加了新工具后，客户端仍会继续显示旧的那几个。

先用 curl 确认**服务端本身是对的**（下面这条不需要 token）：

```bash
curl -s -X POST https://mcp.example.com/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' \
  | grep -o '"name":"[a-zA-Z_]*"' | sort -u
```

应当输出 7 个工具（`pi_initial_prompt`、`read`、`bash`、`edit`、`write`、`grep`、`whoami`）。

- **如果出现 `echo`，或者数量不对** → 线上部署还是旧代码，重新部署即可。
- **如果 7 个都在，但 ChatGPT 显示的不是这些** → 纯客户端缓存，按下面处理：
  1. 连接器页面点 **Refresh**（有时要多点几次）；
  2. 还是不行就**删掉连接器重新添加**（会重新走一次 OAuth）；
  3. 确认没有重复的旧连接器指向同一个地址；
  4. 确认浏览器里没有旧标签页缓存。

为避免客户端把我们当成「没变过」，`serverInfo.version` 取自 `package.json` 的 `version`（`src/version.ts`）。
**每次改动工具集 / 认证方式都要升 `version`**，否则客户端可能一直用缓存里的旧工具列表：

```bash
bun pm version patch   # 或手动改 package.json 的 version，然后重新 bun run build
```

## ChatGPT 接入要点（为什么这样写）

OpenAI 官方文档（[Authenticate users](https://developers.openai.com/plugins/build/auth)）要求 ChatGPT 只有在拿到 **两半信号** 时才会弹出授权 UI：

1. **tool 元数据里的 `securitySchemes`** — 告诉 ChatGPT 哪些 tool 需要 OAuth，以及要申请哪些 scope。
2. **运行时 tool 错误里的 `_meta["mcp/www_authenticate"]`** — 真正触发授权弹窗。

> 这两个字段都 **不在 MCP 规范里**，当前 SDK（`@modelcontextprotocol/server@2.1.0`）也不支持。
> 所以 `src/mcp.ts` 用底层 `Server` 手写 `tools/list` / `tools/call`，自己拼出符合 ChatGPT 要求的描述符。

由此推出三条设计约束：

- **`/mcp` 不能对一切请求返回 401**。匿名 `initialize` / `tools/list` 必须成功，否则 ChatGPT 看不到 tool 和 `securitySchemes`，工具级授权流程根本起不来。
  现在只在「带了 token 但无效」时返回 `401` / `403`，完全不带 `Authorization` 时匿名放行。
- **tool handler 要自己判断 `ctx.http?.authInfo`**，缺 token 时返回 `isError: true` + `mcp/www_authenticate`，而不是抛异常。
- **`whoami` 按 OpenAI profile tool 规范实现**：`_meta["openai/profile"]: true`、`outputSchema` 严格符合其 JSON Schema、返回 `structuredContent`。
  `id` 取 token 的 `sub`（稳定，不随刷新/重连变化），恰好是官方文档强调的语义。

> **`whoami` 是必需的吗？** 对**授权流程**来说不是——触发授权 UI 的是 `securitySchemes` + `mcp/www_authenticate` 这两半信号。
> 但它是 ChatGPT 在连接器里**显示“当前已连接账号”的唯一途径**，删掉后账号会显示为未知，所以保留。
> 注：之前还同时暴露过一个 `echo` 工具（仅用于演示已授权调用），已删除——`bash`/`read` 已足够验证。

### 工具及其认证声明

| 工具 | `securitySchemes` | 说明 |
| --- | --- | --- |
| `pi_initial_prompt` | `oauth2: [mcp]` | 返回 pi 初始提示词：工作目录、系统、时间、可用工具、skill 目录 |
| `read` | `oauth2: [mcp]` | 读文件（复用 pi 的 `read` 工具） |
| `bash` | `oauth2: [mcp]` | 执行 shell 命令（复用 pi 的 `bash` 工具） |
| `edit` | `oauth2: [mcp]` | 精确文本替换（复用 pi 的 `edit` 工具） |
| `write` | `oauth2: [mcp]` | 新建/覆盖文件（复用 pi 的 `write` 工具） |
| `grep` | `oauth2: [mcp]` | 搜索文件内容（复用 pi 的 `grep` 工具） |
| `whoami` | `oauth2: [mcp]` | OpenAI profile tool，返回稳定 `id` 与显示名 |

**所有工具都声明了 `outputSchema`**，并返回与之匹配的 `structuredContent`（否则客户端会提示 “Output schema recommended”）：

- `whoami` → `{ id, name? }`
- `pi_initial_prompt` → `{ prompt, environment, skills, tools, contextFiles }`
- `read`/`bash`/`edit`/`write`/`grep`（及可选 `find`/`ls`）→ `{ output, details? }`

pi 的这几个工具本身就是「自由文本 + 可选细节」的形状（命令输出、文件内容、目录列表……），
所以统一用 `{ output: string, details?: object }` 这信封，而不是给每个工具编一个容易和服务端实际返回对不上的严格 schema：

- `output`：主要文本结果（必填）
- `details`：工具附带的结构化细节，例如 `edit` 的 `diff` / `patch` / `firstChangedLine`；没有时省略
- 工具**执行失败**时（如 `bash false`、读不存在的文件）同样返回 `{ output: "<错误信息>" }` + `isError: true`，
  保证严格校验的客户端不会因为缺 `structuredContent` 报错
- **图片例外**：`read` 读到的图片以 image content block 返回，base64 **不会**写进 `structuredContent`。
  否则一份图片会被重复成两倍体积，对模型来说还是无法阅读的 base64 文本。

实际操作：ChatGPT 先匿名拿到工具列表（含 `securitySchemes`）→ 用户调用工具 → 收到 `mcp/www_authenticate` → 弹出授权 → 登录页 → consent → 重试调用。

### redirect URI allowlist
按官方文档，满足 issuer identification 要求的服务器会收到稳定地址
`https://chatgpt.com/connector_platform_oauth_redirect`，否则是
`https://chatgpt.com/connector/oauth/{callback_id}`。
两者都在 `src/oauth.ts` 的信任列表里（另外仍要求 DCR 注册的 URI 精确匹配），避免注册/使用不一致时卡住。

## pi 集成

### 初始提示词与 skill 发现

`pi_initial_prompt` 扮演的角色相当于 pi 自己的 system prompt。它每次调用都会返回：

- 身份说明与可用工具列表（含 pi 官方的一行工具摘要和 rules）
- `<environment>`：操作系统、架构、主机名、用户、**工作目录**、**当前时间**（含时区）、shell、运行时、pi 版本
- `<skills>`：**启动时**在本机发现的 skill 目录，只有名称/描述/`SKILL.md` 路径，不包含正文
- `<project_context>`：向上查找到的 `AGENTS.md` 等上下文文件
- `<pi_docs>`：pi 自带文档/示例的路径，便于按需阅读

工作目录取进程启动时的 `cwd`（“在哪个目录启动，就在哪个目录干活”），也可用 `PI_MCP_CWD` 覆盖。

skill 发现复用 pi 的 `DefaultResourceLoader`，因此规则与 pi 完全一致：`~/.pi/agent/skills`、`settings.json` 里的 `skills`、`~/.agents/skills`、`~/.claude/skills`、项目 `.pi/skills` / `.agents/skills`（向上递归）以及已安装 pi package 自带的 skill。发现只做一次，启动日志里会打印结果。

> 提示词里只列出 skill 的名称/描述/路径；模型需要时再用 `read` 工具打开对应的 `SKILL.md`，不会把正文一次性塞进上下文。

### 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PI_MCP_CWD` | 进程启动时的 `cwd` | 覆盖工作目录，支持 `~` |
| `PI_MCP_TOOLS` | `read,bash,edit,write,grep` | 通过 MCP 暴露哪些 pi 内置工具（逗号分隔）；可选 `find`、`ls` |

## 自测

```bash
bun run start        # 先在另一个终端启动（正常模式会走登录 + consent）
BASE=https://mcp.example.com bun run scripts/oauth-flow-test.ts
```

覆盖：匿名 `tools/list` + `securitySchemes`、匿名 tool 调用返回 `mcp/www_authenticate`、无效 token 401、发现文档、DCR、密码登录、PKCE 授权、consent 允许/拒绝、code 换 token、错误 verifier 拒绝、已授权 `tools/list` / `tools/call`、refresh token。

脚本会自适应服务端配置：`OAUTH_AUTO_APPROVE=1` 时直接拿 code，否则自动提交 consent 表单。

> 测试脚本通过 `LOGIN_PASSWORD` 环境变量读取密码（默认 `pi-mcp`），需与应用配置一致。

## 目录结构

```
src/
  config.ts     环境变量与常量
  version.ts    服务名与版本号（取自 package.json，写入 serverInfo.version）
  json-schema.ts  inputSchema / outputSchema 共用的 JSON Schema dialect
  log.ts        日志（请求 / OAuth / MCP 事件）与 TUI 输出接管
  tool-log.ts   普通工具日志元数据（正文在 TUI 展开）
  log-policy.ts 内存容量限制与终端控制序列处理
  lifecycle.ts  服务退出时取消正在执行的工具
  monitor/
    store.ts      有界工具历史、开始 / 更新 / 完成事件
    ui.ts         Pi 工具卡片、快捷键、搜索、实时日志视图
    log-reader.ts 纯内存日志分页（不读写文件）
    terminal.ts   禁用终端画面文件录制
    start.ts      TTY 检测、启动与普通日志回退
  keys.ts       RS256 签名密钥（env / 文件 / 自动生成） + 公开 JWKS
  store.ts      client 与 refresh token 的 JSON 持久化
  session.ts    登录 session（签名 cookie）
  html.ts       HTML 渲染小工具
  jwt.ts        access token 签发与校验
  login.ts      密码登录页 / logout
  password-policy.ts  登录密码强度策略（构建与启动共用）
  url-policy.ts       BASE_URL 的 https 强制策略（构建与启动共用）
  oauth.ts      OAuth 2.1 AS：authorize / consent / token / register / revoke
  verifier.ts   MCP Resource Server 侧 token 校验器
  mcp.ts        MCP Server（底层 Server，手写 tools/list + tools/call）
  server.ts     Bun 路由入口
  pi/
    memory-bash.ts Pi shell 执行后端 + 无临时文件的内存输出收集器
    environment.ts  启动时的工作目录与系统信息
    resources.ts    启动时发现 skill 与 AGENTS.md 上下文
    tools.ts        包装 pi 内置工具（read/bash/edit/write/grep/find/ls）
    prompt.ts       构建 pi 风格的初始提示词
    registry.ts     启动时创建一次工具集合
    runtime-dir.ts  编译后定位 pi 运行时资源（PI_PACKAGE_DIR）
scripts/
  build.ts            打包成单文件可执行程序（bun run build）
  oauth-flow-test.ts  端到端流程自测
  tui-demo.ts         独立工具界面演示（不启动服务 / 执行工具）
```

## 生产前必须替换

这是「最简单能跑通」的实现，正式上线前请处理：

1. **真实登录 / 账号体系**：现在是一个共享密码 + 固定用户（`src/login.ts` 的 `DEMO_USER_ID`），所有登录者视为同一人。多用户请接入真实 IdP / 账号系统，并让 `session.userId` 取自真实身份。
2. **密钥管理**：默认按需生成并写入 `~/.pi-mcp/.oauth-jwk.json`，生产环境请用 `OAUTH_JWK` 从 KMS / Secret Manager 注入，避免多实例密钥不一致。
3. **持久化**：`src/store.ts` 用本地 JSON 文件，多实例部署请换成数据库 / Redis。
4. **redirect_uri 白名单**：按需进一步限制允许的域名，避免任意注册。

更彻底的做法是让 OAuth Authorization Server 交给成熟 IdP（Auth0 / Better Auth / 现有 SSO），本服务只做 Resource Server。
