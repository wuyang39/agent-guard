# Native Supervision 浏览器能力设计

日期：2026-08-11  
状态：已确认，待实施

## 1. 目标

main Agent 原生工具监督的控制接口和事件流不能继续依赖“仅监听 loopback”或 Origin。任一本机进程都能构造无 Origin HTTP 请求；如果它可以调用 `stop`，就能关闭 Guard。当前 SSE 也允许未认证回放，会暴露 session key、工具名、lease/decision ID 和结果。

本设计增加浏览器会话能力，同时保留现有检测与管理链路：

- Frontend 仍由 `scripts/start-agent-guard-openclaw.ps1` 自动打开，不要求用户输入长期密钥。
- `start`、`stop`、`status` 只接受已配对浏览器会话。
- Native Guard SSE 使用独立、短期、只读能力。
- OpenClaw Gateway、sample agent 和 Vite 子进程拿不到浏览器 bootstrap token 或后端 control token。
- `/api/v1/openclaw/native-guard/**` 继续使用现有 control token，检测沙箱协议不变。

## 2. 不在本次范围内

- 不增加用户账号、密码、数据库 session 或远程多用户权限模型。
- 不把现有 `AGENT_GUARD_CONTROL_TOKEN` 放入 Vite 环境、Frontend bundle、浏览器存储或 OpenClaw Gateway 环境。
- 不改造 ask SSE、Realtime MCP 或其他 API 的授权模型。
- 不依赖 Origin 作为唯一认证因素。
- 不在 URL query 中携带长期或可复用 secret。

## 3. 威胁边界

需要阻止的调用者：

1. 不持有浏览器会话能力的本机进程；
2. 从恶意网页发起的跨 Origin 请求；
3. 运行在 OpenClaw Gateway 内、可以使用原生网络或命令工具的 main Agent；
4. 未配对客户端对历史 Native Guard 事件的回放。

以下情况不由本设计处理：用户账户已被接管、浏览器进程被完全控制、管理员主动泄露 bootstrap fragment，或操作系统不能隔离同一用户下的进程内存。

## 4. 方案概览

```text
launcher
  |-- 生成一次性 bootstrap token
  |-- 仅注入 backend 子进程
  `-- 打开 http://127.0.0.1:5173/#agent-guard-bootstrap=<token>
                                      |
                                      v
frontend -- POST /native-supervision/access/bootstrap --> backend
          <-- HttpOnly control-session cookie ------------|
                                      |
             start / stop / status <--+
                                      |
frontend -- POST /native-supervision/access/events ------> backend
          <-- HttpOnly read-only SSE cookie ---------------|
                                      |
frontend == EventSource /realtime/events/stream ==========> backend
```

URL fragment 不会进入 HTTP request line、Vite access log 或 backend log。Frontend 读取 token 后立即用 `history.replaceState` 删除 fragment，再发送交换请求。

## 5. 后端能力服务

新增进程内 `NativeSupervisionAccessService`，职责只有 token 生命周期和验证，不调用 coordinator。

### 5.1 Bootstrap token

- 32 个随机字节，base64url 编码。
- 默认十分钟到期，只能成功交换一次。
- launcher 启动 backend 时通过 `AGENT_GUARD_UI_BOOTSTRAP_TOKEN` 注入。
- `server.ts` 在未通过 launcher 启动时生成临时 token，并向控制终端打印一次带 fragment 的本地配对 URL，保证 `npm run api:start` 仍可使用。该终端输出按 secret 处理，不进入 Pino/request log。
- launcher 路径中的 token 只存在于 launcher 内存、backend 环境/内存和浏览器 fragment/短时内存，不写运行日志或持久文件。

### 5.2 Control session

- Bootstrap 交换成功后生成新的 32 字节随机 token。
- Backend 只保存 token digest 和到期时间，默认八小时。
- Cookie 名固定为 `agent_guard_supervision_session`。
- 属性：`HttpOnly; SameSite=Strict; Path=/api/v1/openclaw/native-supervision`。
- HTTPS 时附加 `Secure`；loopback HTTP 开发环境不设置 `Secure`。
- Backend 重启后所有 control session 失效，重新配对。

### 5.3 SSE read capability

- 已认证 control session 才能签发。
- 每次签发使用新的 32 字节随机 token，默认十分钟到期。
- 只允许读取 Native Guard realtime stream，不能调用 `start` 或 `stop`。
- Cookie 名固定为 `agent_guard_native_events`。
- 属性：`HttpOnly; SameSite=Strict; Path=/api/v1/openclaw/realtime/events/stream`，HTTPS 时附加 `Secure`。
- EventSource 建立连接后不因 cookie 到期主动断线；重连或用户重新开始监听前，Frontend 重新签发。

所有时间读取、随机数生成和 token 时效在测试中可注入。比较固定长度 secret 时使用 constant-time 比较。过期 token 在验证时清理，不写磁盘。

## 6. HTTP 合约

### 6.1 配对

`POST /api/v1/openclaw/native-supervision/access/bootstrap`

请求体：

```json
{ "token": "<one-time-bootstrap-token>" }
```

要求：

- `Origin` 必须是允许列表中的精确 HTTP(S) origin；缺失、`null`、通配或不匹配均返回 403。
- body 必须只有 `token`，超长、缺失或额外字段返回 400。
- token 错误、已用或过期返回 401，且不设置 cookie。
- 成功返回 204 并设置 control-session cookie。

### 6.2 签发事件能力

`POST /api/v1/openclaw/native-supervision/access/events`

- 要求精确 Origin 和有效 control-session cookie。
- 成功返回 204 并设置只读 SSE cookie。
- control session 缺失、错误或过期返回 401。

### 6.3 控制接口

以下接口要求精确 Origin 和有效 control-session cookie：

- `GET /api/v1/openclaw/native-supervision`
- `POST /api/v1/openclaw/native-supervision/start`
- `POST /api/v1/openclaw/native-supervision/stop`

鉴权在 schema 校验和 service 调用之前完成。失败时 coordinator/service 调用次数必须为零。错误使用稳定 code：

- `NATIVE_SUPERVISION_ORIGIN_FORBIDDEN`：403
- `NATIVE_SUPERVISION_ACCESS_REQUIRED`：401
- `NATIVE_SUPERVISION_BOOTSTRAP_INVALID`：401

### 6.4 SSE

`GET /api/v1/openclaw/realtime/events/stream`

- 在 `reply.hijack()` 和 replay/subscribe 之前验证精确 Origin 与 `agent_guard_native_events`。
- 未授权请求返回 JSON 401，不建立 SSE，不执行 replay，不注册 subscriber。
- 恶意或缺失 Origin 返回 403。
- 授权响应只回显已允许的 Origin，并设置 `Access-Control-Allow-Credentials: true`；删除 `Access-Control-Allow-Origin: *`。

## 7. Frontend 流程

Frontend API client 对 backend fetch 统一使用 `credentials: "include"`。原生监督相关调用在第一次执行前运行一次配对检查：

1. 从 `window.location.hash` 读取 `agent-guard-bootstrap`；
2. 立即删除 fragment，token 只保留在函数局部变量；
3. 调用 bootstrap 交换接口；
4. 同一页面内的并发调用共享 singleflight promise；
5. 页面没有 fragment 时直接使用已有 cookie，401 以明确错误显示，不回退到无认证请求。

开始监听 realtime stream 前，Frontend 先调用事件能力签发接口。签发成功后才创建主 EventSource，并使用 `{ withCredentials: true }`。ask EventSource 保持原行为。

开始 main supervision 的顺序是：配对完成、签发 SSE 能力、调用 `start`、收到 active 后打开事件流。SSE 打开失败不撤销已激活 lease。Stop 只撤销 lease，不关闭事件流，和现有交互一致。

## 8. Launcher 环境隔离

`scripts/start-agent-guard-openclaw.ps1` 为每个子进程构造临时环境覆盖，并在 `Start-Process` 返回后恢复父进程环境。

| 变量 | Gateway | Sample | Backend | Frontend |
|---|---:|---:|---:|---:|
| `OPENCLAW_GATEWAY_TOKEN` | 是 | 否 | 是 | 否 |
| `AGENT_GUARD_CONTROL_TOKEN` | 否 | 否 | 是 | 否 |
| `AGENT_GUARD_UI_BOOTSTRAP_TOKEN` | 否 | 否 | 是 | 否 |
| `AGENT_GUARD_FRONTEND_ORIGIN` | 否 | 否 | 是 | 否 |

launcher 设置 `AGENT_GUARD_ALLOWED_ORIGINS`，包含本次实际 `FrontendPort` 对应的 `http://127.0.0.1:<port>`。默认打开的 URL 携带 bootstrap fragment；`-NoBrowser` 时只打印配对 URL。

进程计划、PID 文件和日志不能包含 bootstrap/control token。现有持久 control-token 文件继续服务 native-guard 管理 API，但不会用于浏览器配对。

## 9. CORS 与日志

Fastify CORS 允许 credential response，但敏感路由仍执行自己的精确 Origin gate。Cookie 的 Path 限制避免 control session 被发送到其他 API；SSE cookie 只发送到 stream path。

logger redaction 新增：

- `req.headers.cookie`
- `res.headers.set-cookie`
- bootstrap 请求体中的 `token`

错误响应、SSE event、status DTO 和前端状态不得包含任何 token、digest 或 cookie 值。

## 10. 失败与恢复

- Bootstrap token 交换失败不改变 Guard 状态。
- Control session 到期后，已激活 lease 继续由 backend timer/coordinator 管理；UI 只失去控制权限。
- SSE capability 签发或连接失败不撤销 lease。
- Backend 重启使浏览器 cookie 失效；launcher 重启或 server 打印的新配对 URL 用于恢复。
- 旧页面持有的 cookie 不能跨 backend generation 使用。
- 未启用 Agent Guard 时，OpenClaw 原有工具执行行为不变；本设计只保护控制面和事件读取。

## 11. 测试

### 11.1 能力服务

- bootstrap 正确、错误、重复、过期和长度边界；
- control session 与 SSE capability 的独立权限和到期；
- Backend generation 变化后旧 token 失效；
- constant-time token 比较路径和有界存储清理。

### 11.2 Handler / App

- start/stop/status 在无 cookie、错误 cookie、缺失 Origin、`null` Origin、恶意 Origin 时拒绝，service 零调用；
- 合法 bootstrap 设置正确 cookie 属性；
- control cookie 不能直接读取 SSE，SSE cookie 不能调用 stop；
- 未授权 SSE 不 hijack、不 replay、不 subscribe；
- 授权 SSE 可接收 sanitized `native_tool_hook`；
- preflight 只允许精确 Origin，并返回 credential CORS 标志。

### 11.3 Frontend

- fragment 读取后立即移除；
- bootstrap singleflight；
- fetch 带 credentials；
- stream 打开前先签发只读能力；
- EventSource 使用 `withCredentials`；
- 配对/SSE 签发失败不误报 streaming，也不自动 stop lease。

### 11.4 Launcher

- Gateway/sample/frontend 环境中没有 control/bootstrap token；
- Backend 收到所需 token 和实际 frontend origin；
- 浏览器 URL 使用 fragment，`-NoBrowser` 输出相同 URL；
- plan、PID manifest 和日志不包含 secret。

## 12. 验收条件

实现完成后必须满足：

1. 未配对本机进程无法读取 status、启动或停止 main supervision；
2. 恶意网页无法控制监督或回放 Native Guard 事件；
3. Frontend 经 launcher 启动后无需手工输入密钥；
4. OpenClaw Gateway 环境不含浏览器 bootstrap token 和 Agent Guard control token；
5. detection exact-session lease、PDP/evidence handler 和 OpenClaw 普通 OFF 行为无回归；
6. `verify:native-guard`、frontend tests、三套 typecheck 和 `verify:all` 通过。
