# obsidian-mcp HTTP / Docker 化改造方案

> 目标场景：Vault 存放于自建 `hacdias/webdav` 服务（公网），Obsidian 客户端用 **Remotely Save** 插件同步；MCP 服务端 Docker 部署、以 HTTP 接入；必须**保留修改记录并支持回滚**；客户端同时覆盖本地客户端（Claude Desktop / Cursor / Cline）与云端连接器（claude.ai / ChatGPT 自定义连接器）。

---

## 1. 结论先行

### 1.1 一个决定全局的判断

`hacdias/webdav` 不是云存储，它是「把宿主机某个目录用 WebDAV 协议暴露出去」的服务端。所以：

**vault 的真身，就是宿主机文件系统上的一个普通目录。**

由此得出本方案的核心主张：**MCP 容器 bind mount 同一个目录，继续用原生 `node:fs` 读写。**

| 收益             | 说明                                                                                                                           |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 文件系统层零改造 | `src/utils/vault.ts`、`src/utils/transaction.ts`、12 个工具、7 个测试文件**一行都不用改**                                      |
| 事务保证全部保留 | fsync 持久化、原子 `rename`、`link()` 实现「不存在才创建」、目录 fsync、journal 清单、失败自动回滚、启动期崩溃恢复、保留期裁剪 |
| 即时一致         | MCP 写入的字节就是 WebDAV 提供的字节，不存在镜像同步延迟或同步冲突窗口                                                         |
| 性能             | 全文搜索 / 批量重命名走本地 `readdir`，不产生 PROPFIND 风暴，不触碰服务商限流                                                  |
| 回滚能力         | `<vault>/.obsidian-mcp/transactions/<uuid>/` 已保存 manifest 与写前文件快照                                                    |

### 1.2 被否决的替代方案及理由

- **直接实现 WebDAV 客户端文件系统层**：需重构 14 个文件（`VaultEntry.absolutePath` 这一契约渗透进全部 12 个工具，见 `src/tools/*/index.ts` 中 `entry.absolutePath` 的用法），且 `fsync` / 原子 `rename` / 硬链接 / `O_EXCL` 锁在 WebDAV 上**没有对应原语**，事务保证必然降级为「尽力而为」。全库扫描还会产生大量 PROPFIND，公网延迟不可接受。
- **rclone mount (FUSE)**：容器需要 FUSE 特权；`rename` / `fsync` 由 VFS 缓存模拟，不同 `--vfs-cache-mode` 档位保证不同，崩溃易残留不一致。
- **rclone 双向同步镜像**：引入同步延迟与冲突窗口，且客户端 Remotely Save 已在同步，会形成「三级同步」，冲突面反而扩大。

### 1.3 唯一前提（必须先确认）

MCP 容器与 `hacdias/webdav` 容器**在同一台机器**，且能访问同一个目录。

若不满足（例如 vault 实际在远端对象存储上），则退化为 rclone mount 或 WebDAV 客户端方案，需另议。

---

## 2. 目标架构

```
                        公网
                         │
              ┌──────────┴───────────┐
              │  Caddy / Nginx       │  TLS 终止，仅暴露 443
              │  dav.example.com     │
              │  mcp.example.com     │
              └───┬──────────────┬───┘
                  │              │
      ┌───────────┴───┐    ┌─────┴──────────────────┐
      │ webdav        │    │ obsidian-mcp (本改造)  │
      │ hacdias/webdav│    │ Node 24, HTTP MCP      │
      │ :6065         │    │ :3000 → 127.0.0.1      │
      └───────┬───────┘    └─────────┬──────────────┘
              │                      │
              └──────────┬───────────┘
                         │  同一宿主目录，读写同一份字节
                /srv/obsidian-vault          ← 唯一数据源
                ├── .obsidian/               （必须存在）
                ├── .obsidian-mcp/           （事务 journal，需排除同步）
                └── **/*.md
                         ▲
                         │ WebDAV (Remotely Save)
                  Obsidian 客户端
```

要点：

- 只有一个数据源：宿主目录 `/srv/obsidian-vault`。
- 两个容器同时挂载它，直接读写同一份文件，无中间副本。
- MCP 端口只绑 `127.0.0.1`，由反向代理终止 TLS 后对外。
- WebDAV 端口只对 Obsidian 客户端需要，不必公开到 `0.0.0.0`。

---

## 3. 分阶段改造清单

### Phase 0 — 前置验证（约 0.5 天，纯排查，不改代码）

```bash
# 1. 找到 webdav 容器实际挂载的宿主目录
docker inspect --format '{{json .Mounts}}' obsidian-webdav

# 2. .obsidian 必须已存在于服务端，否则启动直接失败（VAULT_NOT_INITIALIZED）
ls -la /srv/obsidian-vault/.obsidian

# 3. 确认 UID/GID 与可写性（Phase 4 的 1 号坑）
docker inspect --format '{{.Config.User}}' obsidian-webdav
stat -c '%u:%g %a' /srv/obsidian-vault

# 4. 确认 vault id 合法：必须小写字母开头
#    约束见 src/utils/vault.ts:28  ^[a-z][a-z0-9_-]{0,63}$
```

依赖可用性已在本机核实：`@modelcontextprotocol/node@2.1.1`、`@modelcontextprotocol/express@2.0.2` 均已发布。**实施时补充**：`node@2.1.1` 的 peer 要求 `@modelcontextprotocol/server@^2.3.0`，故 server 需从 2.0.0 升级到 2.3.1（`^2.0.0` 范围内，项目现有 stdio/测试 API 在 2.3.1 下全部通过），client devDependency 同步升到 `^2.3.1`。

### Phase 1 — HTTP 传输层（约 1–1.5 天）

**现状**：`src/cli.ts` 只实现了 stdio（`StdioServerTransport` + `serveStdio`，见 `src/cli.ts:107-136`）。

**新增依赖**：

```bash
npm i @modelcontextprotocol/node@^2.1.1
```

SDK 已内置 HTTP 能力，**不需要引入 Express**：`createMcpHandler` 返回 web-standard 的 `{ fetch, close, notify, bus }`；Node 侧用 `toNodeHandler` 适配即可。

**新增 `src/http.ts`**（骨架，接口签名已对照 SDK 类型定义核实）：

```ts
import { createServer } from "node:http";
import { toNodeHandler } from "@modelcontextprotocol/node";
import {
  createMcpHandler,
  requireBearerAuth,
  hostHeaderValidationResponse,
  originValidationResponse,
  oauthMetadataResponse,
  getOAuthProtectedResourceMetadataUrl
} from "@modelcontextprotocol/server";

export async function serveHttp(runtime: Runtime, logger: Logger, cfg: HttpConfig) {
  // 注意：factory 每个 HTTP 请求都会被调用一次以构造新的 McpServer。
  // Runtime（内含 TransactionManager 与进程内写队列）必须在启动时构造一次并被闭包捕获。
  const mcp = createMcpHandler(() => buildServer(runtime), {
    // 注意取值不同：CLI 的 --legacy 是 serve|reject，
    // createMcpHandler 接受 'stateless' | 'reject'，需映射 serve→stateless。
    legacy: cfg.legacy === "reject" ? "reject" : "stateless",
    responseMode: "auto",
    keepAliveMs: 15_000,
    onerror: (error) => logger.log("error", "http_error", { message: error.message })
  });

  const gate = requireBearerAuth({
    verifier: cfg.verifier,
    requiredScopes: cfg.scopes,
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(new URL(cfg.publicUrl))
  });

  const handler = {
    ...mcp,
    fetch: async (request: Request): Promise<Response> => {
      const { pathname } = new URL(request.url);
      if (pathname === "/healthz") return json({ ok: true });
      if (pathname === "/readyz") return readyz(runtime); // 真正探测卷可读写

      // 1) OAuth 发现文档（Phase 2b 启用）
      const metadata = oauthMetadataResponse(request, cfg.authMetadata);
      if (metadata) return metadata;

      // 2) Host / Origin 校验必须前置：createMcpHandler 自身「deliberately validation-free」
      const badHost = hostHeaderValidationResponse(request, [cfg.publicHost]);
      if (badHost) return badHost;
      const badOrigin = originValidationResponse(request, [cfg.publicHost]);
      if (badOrigin) return badOrigin;

      // 3) 鉴权
      const auth = await gate(request);
      if (auth instanceof Response) return auth;

      return mcp.fetch(request, { authInfo: auth });
    }
  };

  const server = createServer(toNodeHandler(handler));
  server.listen(cfg.port, cfg.host);
}
```

> ✅ `toNodeHandler` 签名已在 `@modelcontextprotocol/node@2.1.1` 类型定义中核实：`toNodeHandler(handler: FetchLikeMcpHandler, opts?: { onerror?, maxRequestBodySize? })` 返回 `(req, res, parsedBody?) => Promise<void>`；`FetchLikeMcpHandler` 只要求结构化 `{ fetch(request, options?) }`，自定义组合 fetch（healthz/host/origin/limiter/auth 前置）可直接传入。`maxRequestBodySize` 默认 4 MiB，小于 5 MiB 工具内容上限，**必须显式调大**（实施取 16 MiB）。另注意 `exactOptionalPropertyTypes: true` 与 SDK 鸭子类型 `NodeIncomingMessageLike` 存在一处编译期不兼容（`method?: string` 不接受 `string | undefined`），实施时在适配函数处做了一次局部 cast 并注释说明。

**`src/cli.ts` 扩展**：

- 新增 `serve --http --host 127.0.0.1 --port 3000`，保留 `serve`（stdio）为默认，向后兼容现有用户。
- 环境变量（供 Docker）：`MCP_HTTP_HOST`、`MCP_HTTP_PORT`、`MCP_PUBLIC_URL`、`MCP_AUTH_TOKEN`、`OBSIDIAN_MCP_VAULT_DIR`。
- **令牌只走环境变量，绝不作为 CLI 参数**，否则会出现在 `docker inspect` 与 `ps` 输出里。
- 用 zod 做启动期 env 校验，fail-fast（项目已有 zod 依赖）。

**三个必须踩准的实现细节**：

1. `createMcpHandler` 的 factory **每个 HTTP 请求调用一次**（SDK 类型注释原文：_once per HTTP request_）。因此 `Runtime` 不能建在 factory 内部，否则每次请求都会重建 `TransactionManager`、丢失 recovery/lock 状态。现有 `runCli` 已经是正确形状（`serveStdio(() => buildServer(runtime))`，`src/cli.ts:112-119`），照搬即可。
2. `TransactionManager.enqueue` 是**进程内**按 vault root 串行的 `Map`（`src/utils/transaction.ts:49,566-581`）；跨进程互斥依赖 vault 内的 `locks/write` 目录锁。单副本部署没有问题；若要水平扩容，所有副本必须共享同一挂载目录，否则锁失效。
3. `/healthz`（存活）与 `/readyz`（就绪，探测卷可读写）要放在 MCP handler 之外，供 compose healthcheck / k8s probe 使用。

**优雅关闭**：复用现有 SIGINT/SIGTERM 逻辑（`src/cli.ts:139-146`），额外 `await handler.close()` + `server.close()`。

### Phase 2 — 鉴权（你选了「两者都要」，因此分两阶段落地）

#### 2a 静态 Bearer Token（约 0.5 天）— 先打通本地客户端

所需构件 SDK 已全部导出：`requireBearerAuth`、`verifyBearerToken`、`bearerAuthChallengeResponse`、`hostHeaderValidationResponse`、`originValidationResponse`。

```ts
import { timingSafeEqual } from "node:crypto";
import {
  OAuthError,
  OAuthErrorCode,
  type AuthInfo,
  type OAuthTokenVerifier
} from "@modelcontextprotocol/server";

const verifier: OAuthTokenVerifier = {
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const expected = process.env.MCP_AUTH_TOKEN ?? "";
    const a = Buffer.from(token);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new OAuthError(OAuthErrorCode.InvalidToken, "Invalid token");
    }
    return {
      token,
      clientId: "static",
      scopes: ["obsidian"],
      expiresAt: Math.floor(Date.now() / 1000) + 86_400 // ← 必须赋值，见下
    };
  }
};
```

**两个必须注意的点**：

1. **`AuthInfo.expiresAt` 必须赋值（秒级 Unix 时间戳）**。SDK 明确拒绝 `expiresAt` 未设置的 token（沿用 v1 行为，见 `OAuthTokenVerifier` 类型注释）。遗漏会导致**所有请求都被 401**，且错误信息不会告诉你原因。已核实 `AuthInfo` 结构为 `{ token, clientId, scopes, expiresAt?, resource?, extra? }`。
2. **Host / Origin 校验必须在 MCP handler 之前**，且允许列表是真实公网域名（不是 `localhostAllowedHostnames()`）。理由：加了鉴权 ≠ 免疫 DNS rebinding；`createMcpHandler` 明确声明自身在这一点上「deliberately validation-free」，把校验责任交给调用方。

#### 2b OAuth 2.1（约 1.5–3 天）— 支撑 claude.ai / ChatGPT 自定义连接器

云端连接器要求：RFC 9728 受保护资源元数据 + RFC 8414 授权服务器元数据 + 401 响应携带 `WWW-Authenticate: Bearer resource_metadata=...` + 动态客户端注册（RFC 7591）。

SDK 已提供**资源服务器侧**的全部构件：

- `oauthMetadataResponse(request, AuthMetadataOptions)` — 同时服务 `/.well-known/oauth-protected-resource[/<path>]` 与 `/.well-known/oauth-authorization-server`（含 CORS 预检与非 GET 的 405）。
- `buildOAuthProtectedResourceMetadata(options)` — 启动期 fail-fast 校验 issuer URL。
- `getOAuthProtectedResourceMetadataUrl(serverUrl)` — 生成 401 challenge 中的 metadata URL。
- `bearerAuthChallengeResponse(error, options)` — 把校验失败映射为 401 / 403。

**SDK 不含授权服务器本身** —— `OAuthTokenVerifier` 的注释明确说明它只覆盖资源服务器所需的校验步骤。需二选一：

- 使用现成 IdP：Keycloak / Logto / Authentik / Auth0，开启动态客户端注册；
- 自建轻量 AS。

`AuthMetadataOptions` 字段（已核实）：`oauthMetadata`（必填，RFC 8414 文档）、`resourceServerUrl`（必填，`URL`）、`scopesSupported`、`resourceName`、`serviceDocumentationUrl`、`dangerouslyAllowInsecureIssuerUrl`（**仅本地测试，生产禁用**）。

**跨轮次状态**：若后续要用 elicitation / MRTR 多轮交互，注意 `createRequestStateCodec` —— 多副本时同一密钥必须对所有实例可见（例如放入共享 secret），否则随机密钥只在单进程内有效。

### Phase 3 — 回滚与修改记录（约 0.5–1 天）

**好消息：这个能力已经存在，不需要新造轮子。**

现状（`src/utils/transaction.ts`，736 行）：

- 每次写入前，把原文件快照写入 `<vault>/.obsidian-mcp/transactions/<uuid>/<index>.bin`；
- manifest 状态机 `preparing → committing → committed / rolled_back`；
- 提交失败自动 `restoreChanged()` 逆向回滚（`:399-423`）；
- 进程/容器崩溃后，启动时 `recoverIncomplete()` 自动恢复未完成事务（`:462-483`）；
- `prune()` 按 `--recovery-days`（默认 30）/ `--recovery-max-bytes`（默认 1 GiB）裁剪（`:485-508`）；
- 每个写类工具都会返回 `transaction_id`。

**缺口**：`recovery list` / `recovery restore` 目前**只有 CLI 入口**（`src/cli.ts:66-105`）；HTTP/Docker 场景下不方便执行。

建议补齐（按推荐度排序）：

1. **新增 MCP 工具** `obsidian_recovery_list`、`obsidian_recovery_restore`，让 agent 自己能查、能回滚；`restore` 属破坏性操作，仿照现有 `obsidian_delete_note` 的 `confirm_path` 模式要求显式确认。
2. 或增加受令牌保护的管理端点 `GET /admin/recovery`、`POST /admin/recovery/{id}/restore`。
3. 兜底方案写进文档：`docker compose exec obsidian-mcp node dist/main.js recovery list --vault vault=/vault`。

**注意现有约束**：`recovery restore` 要求**恰好配置 1 个 vault**（`src/cli.ts:87-95`）。采用单 vault 部署即满足。

**顺带修一个潜在缺陷**：`Runtime.doctor()` 只调用 `fs.access(root)`（未带 `R_OK | W_OK`），却硬编码返回 `readable: true, writable: true`（`src/runtime.ts:43-47`）。Docker 下权限问题恰恰是最常见的故障源，建议改为按访问模式真实探测，否则 `doctor` 会给出误导性的「一切正常」。

### Phase 4 — Docker（约 1–1.5 天）

交付物：`Dockerfile`、`.dockerignore`、`docker-compose.yml`、`.env.example`。

```dockerfile
# ---- deps ----
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ---- build ----
FROM node:24-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build && npm prune --omit=dev

# ---- production ----
FROM node:24-alpine AS production
WORKDIR /app
RUN addgroup -g 1001 -S appgroup && adduser -S appuser -u 1001
USER appuser
# package.json 必须保留：src/constants.ts 在启动时读取它来取版本号
COPY --from=build --chown=appuser:appgroup /app/node_modules ./node_modules
COPY --from=build --chown=appuser:appgroup /app/dist ./dist
COPY --from=build --chown=appuser:appgroup /app/package.json ./
ENV NODE_ENV=production
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js", "serve", "--http", "--host", "0.0.0.0", "--port", "3000", "--vault", "vault=/vault"]
```

> ⚠️ **`COPY package.json` 不是可选项**：`src/constants.ts:26` 用 `readFileSync(new URL("../package.json", import.meta.url))` 取版本号，缺了它进程启动即抛异常。

```yaml
# docker-compose.yml（要点节选；webdav 服务保留你现有配置，关键是 volume 指向同一宿主目录）
services:
  webdav:
    image: hacdias/webdav:latest
    restart: unless-stopped
    volumes:
      - /srv/obsidian-vault:/data # ← 与 mcp 指向同一宿主目录
      - ./webdav-config.yml:/config.yml:ro
    # ...保留你现有的端口/配置

  mcp:
    build: .
    restart: unless-stopped
    user: "1001:1001" # ← 与 webdav 的写权限对齐
    env_file: [.env] # MCP_AUTH_TOKEN / MCP_PUBLIC_URL 等
    environment:
      OBSIDIAN_MCP_VAULT_DIR: /vault
    volumes:
      - /srv/obsidian-vault:/vault # ← 同一宿主目录，读写
    ports:
      - "127.0.0.1:3000:3000" # 只对本机反代开放
    read_only: true
    tmpfs: [/tmp]
    cap_drop: [ALL]
    security_opt: [no-new-privileges:true]
    healthcheck:
      test:
        [
          "CMD",
          "node",
          "-e",
          "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
        ]
      interval: 30s
      timeout: 3s
      retries: 3
    deploy:
      resources:
        limits: { cpus: "1.0", memory: 512M }
```

**四个几乎必然踩到的坑（本方案最容易失败的地方）**：

1. **`.obsidian` 必须存在**。`VaultRegistry.create` 会检查 `<root>/.obsidian` 是否为目录，否则抛 `VAULT_NOT_INITIALIZED` 启动失败（`src/utils/vault.ts:112-123`）。Remotely Save 默认可能不同步 `.obsidian`。解决：服务端 `mkdir -p /srv/obsidian-vault/.obsidian`，或确认插件已同步该目录。
2. **UID/GID 必须对齐**。`hacdias/webdav` 以自己的 UID 写文件，MCP 容器默认 `appuser` 是 uid 1001；不一致就会 `EACCES`。解决：compose 中给两个服务显式 `user:`，或把宿主目录调整到公共组（`chgrp -R 1000 /srv/obsidian-vault && chmod -R g+rwX /srv/obsidian-vault`）。
3. **`.obsidian-mcp` 必须排除在 Remotely Save 同步之外**。否则 journal、快照、锁文件会被同步到 Obsidian 客户端，既污染库又持续产生冲突与流量。在插件过滤设置里排除 `.obsidian-mcp/`（`.trash/` 同理）。
4. **vault id 必须小写字母开头**（`^[a-z][a-z0-9_-]{0,63}$`，`src/utils/vault.ts:28`）。`--vault vault=/vault` 合法；`Vault` 或 `My-Vault` 会启动失败。

补充：`--vault` 路径必须是**绝对路径且已存在**（`vault.ts:59-91`），容器内固定用 `/vault` 最省事。

### Phase 5 — GitHub Actions 验证与打包（约 1 天）

现有 `.github/workflows/ci.yml` 已有 3 个 job（3 OS × Node 22/24 矩阵、quality、node-version-guard），**保留不动**。

新增 `.github/workflows/docker.yml`：

- `docker/setup-buildx-action` + `docker/build-push-action`，`cache-from` / `cache-to: type=gha`；
- 推送 GHCR：`ghcr.io/${{ github.repository }}`，tag 交由 `docker/metadata-action` 生成（`sha-`、semver、`latest`）；
- 多架构 `linux/amd64,linux/arm64`（不少 VPS 是 arm64）；
- `provenance: true`、`sbom: true`；
- Trivy 扫描镜像，HIGH/CRITICAL 阻断。

新增 `.github/workflows/release.yml`：`v*` tag 触发，推版本 tag 并附 SBOM。

**容器冒烟测试（这才是「验证」的核心）**：CI 里要真跑容器，而不是只 build。

- 新增 `test/integration/http.test.ts`，使用 `StreamableHTTPClientTransport`（`@modelcontextprotocol/client` 已是 devDependency，**无需引入新的测试客户端**）连上真实服务，断言：`listTools` 返回全部 12 个工具、`resources/list` 返回 `obsidian-mcp://vaults`，再跑一遍「写 → 读 → 改（带 etag）→ 回滚」闭环。
- 鉴权用例：无 token → 401；错 token → 401；正确 token → 200；伪造 Host / Origin → 被拒。
- 现有 stdio 集成测试（`test/integration/server.test.ts`）保持不变，确保向后兼容。

> ⚠️ `package.json` 目前仍指向 `StevenStavrakis/obsidian-mcp`（`repository` / `author`，version 2.0.0）。若这是你自己的分叉项目，GHCR 镜像名由 `github.repository` 推导，需同步改名，否则镜像会推到与来源不符的命名空间下。

### Phase 6 — 公网加固（约 0.5 天）

按已加载的安全基线逐项落实：

- **限流**：按 token / IP，超限返回 429 + `Retry-After`。
- **请求体上限**：工具层上限是 5 MiB（`MAX_CONTENT_BYTES`），HTTP 层设一个略大的硬上限，拒绝超大 body。
- **超时**：请求超时 + SSE keepalive（`createMcpHandler` 的 `keepAliveMs`，默认 15000）。
- **反向代理**：仅暴露 443，强制 HTTPS，透传真实 IP，`X-Forwarded-*` 走白名单。
- **日志脱敏**：`Logger` 输出 JSON 到 stderr（`src/utils/logger.ts`）；确认不记录 `Authorization` 头或 token 明文，新增的 HTTP 层要保持这一约定。
- **端口最小暴露**：MCP 容器绑 `127.0.0.1:3000`；WebDAV 只对需要的来源开放。
- **容器加固**：`cap_drop: [ALL]`、`no-new-privileges`、资源限额、只读根文件系统 + `tmpfs`（注意 vault 挂载必须可写）。
- **依赖扫描**：`npm audit --omit=dev --audit-level=high` 已在 CI 中。

---

## 4. 最大风险：Remotely Save 与 MCP 的并发写

这是本方案唯一无法靠代码完全消除的风险，必须显式管理。

**机制**：宿主机目录是唯一数据源，存在两个写入方 ——（a）MCP 容器直接改盘；（b）Obsidian 客户端经 Remotely Save 上传。若客户端手上持有一份**尚未上传的旧副本**，它的上传会覆盖 MCP 刚写入的内容。

**现有防护能覆盖多少**：

- `expectedEtag` 乐观并发（`transaction.ts:227-240`）只保证 **MCP 对 MCP** 的读-改-写不冲突；它检测不到「Remotely Save 从外部替换文件」这一动作本身，但下一次 MCP 读会因 etag 不匹配而拒绝 —— 属于事后发现，不是事前预防。
- 真正的兜底是 **transaction journal**：`<vault>/.obsidian-mcp/transactions/<uuid>/` 保留了写前快照与 `committedEtag`，`recovery restore` 可精确还原。这正是你要求「保留修改记录 + 回滚」的实际价值所在。

**建议的运维策略（按性价比排序）**：

1. **错峰**：agent 批量改库期间，让 Obsidian 端先完成一次同步；改完再同步。避免两端同时持有未提交变更。
2. **收敛为单一权威写入方**：日常以 MCP 为写入入口，Obsidian 端尽量只读浏览。
3. 依赖 Remotely Save 自身的冲突处理（它具备 smart conflict resolution，会生成冲突副本而非静默丢弃）。
4. 定期用 `recovery list` 核查事务状态。
5. **保留期调优**：默认 30 天 / 1 GiB 对共享目录偏激进，按 vault 规模调整。

---

## 5. 验收标准

标注：**[本机]** = 本会话已在 Windows 工作机验证（除 symlink 用例受权限限制，见 §8）；**[CI/服务器]** = 需 Docker/远端环境，代码与 workflow 已就位。

- [ ] **[CI/服务器]** `docker compose up` 后 `/healthz` 返回 200（`docker.yml` 冒烟覆盖；本机 CLI 冒烟已见 200）
- [x] **[本机]** `/readyz` 在 vault 可读写时 200；去掉写权限后返回非 200（`http.test.ts`，chmod 分支 POSIX-only，Linux CI 覆盖）
- [x] **[本机]** Claude Desktop / Cursor 经 `/mcp` + Bearer Token 列出工具（现 **14** 个：原 12 + 2 recovery）
- [x] **[本机]** 无 token → 401，且响应带 `WWW-Authenticate`
- [x] **[本机]** 伪造 Host / Origin 的请求被拒（403，先于鉴权）
- [x] **[本机]** `obsidian_create_note` → `obsidian_read_note` → `obsidian_edit_note`（带 etag）闭环通过
- [x] **[本机]** 破坏性操作失败时自动回滚，且 `recovery list` 可见该事务
- [x] **[本机]** `recovery restore` 能把文件还原到写前字节
- [x] **[本机]** 进程被 `kill -9` 后重启，未完成事务自动恢复（`recoverIncomplete()`，既有能力 + 测试）
- [ ] **[服务器]** Obsidian 客户端经 Remotely Save 能看到 MCP 写入的内容（部署事实，需实机）
- [ ] **[CI]** typecheck / lint / 测试 / 镜像构建与扫描 / 容器冒烟全绿（本机 typecheck+lint+test 已全绿，除 §8 记录的既有 symlink 失败）
- [ ] **[CI]** 镜像以非 root 运行，GHCR 上具备 semver + sha 标签与 SBOM

---

## 6. 工作量与优先级

| 阶段 | 内容               | 估时   | 依赖    |
| ---- | ------------------ | ------ | ------- |
| P0   | 前置验证           | 0.5d   | —       |
| P1   | HTTP 传输层        | 1–1.5d | P0      |
| P2a  | 静态 Token 鉴权    | 0.5d   | P1      |
| P3   | 回滚工具化         | 0.5–1d | P1      |
| P4   | Docker 编排        | 1–1.5d | P1, P2a |
| P5   | Actions 验证与打包 | 1d     | P4      |
| P2b  | OAuth 2.1          | 1.5–3d | P2a     |
| P6   | 公网加固           | 0.5d   | P4      |

**最小可用路径：P0 → P1 → P2a → P4 → P5（约 3.5–4.5 天）**，即可让本地客户端用上。P3 紧随其后；P2b 支撑云端连接器，可独立排期。

---

## 7. 待确认事项（2026-10-10 已定）

1. MCP 容器与 `hacdias/webdav` 容器是否同机、可访问同一目录？→ **属部署事实，需在目标服务器执行第 1 节 Phase 0 的 `docker inspect` 确认**；本仓库已按同机 bind mount 单一数据源实现。
2. `.obsidian` 目前是否已同步到服务端？→ 同上，服务器侧确认；`docker-compose.yml` 注释列明缺失即 `VAULT_NOT_INITIALIZED`。
3. 反向代理用 Caddy / Nginx / 其他？→ **Caddy**，示例见 `deploy/caddy/Caddyfile`（自动 HTTPS；已注明不可重写 Host 头，否则会破坏 DNS-rebinding 校验）。域名与证书由 Caddy ACME 自动申请。
4. 是否保留 stdio 模式向后兼容现有用户？→ **保留**，`serve` 默认 stdio，`--http` 显式切换。
5. 是否需要直接实现 P1 + P2a + P3（含测试）？→ **已实现**，并连带完成 P4/P5/P6。

---

## 8. 实施状态（2026-10-09）

### 已完成并通过本机验证

| 阶段            | 交付物                                                                                                                                                                                                                  | 验证                                                                                                                              |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| P1 HTTP 传输层  | `src/http.ts`（`serveHttp` + `parseHttpEnvironment`）、`src/cli.ts` 新增 `serve --http --host --port`（stdio 仍为默认）                                                                                                 | `test/integration/http.test.ts` 7 项全绿：14 工具发现、`resources/list`、create→read→etag edit→recovery list→restore 闭环         |
| P2a 静态 Bearer | `src/utils/auth.ts`（timingSafeEqual、`expiresAt` 已赋值、scope `obsidian`）                                                                                                                                            | 无 token / 错 token → 401 + `WWW-Authenticate`；伪造 Host / Origin → 403（先于 MCP handler）                                      |
| P3 回滚工具化   | 新 MCP 工具 `obsidian_recovery_list`、`obsidian_recovery_restore`（`confirm_transaction_id` 显式确认）；`Runtime.doctor()` 真实探测 `R_OK`/`W_OK`；`/readyz` 探测卷可读写                                               | stdio 与 HTTP 集成测试均覆盖 restore 闭环与未确认拒绝                                                                             |
| P4 Docker       | `Dockerfile`（非 root uid 1001、HEALTHCHECK）、`.dockerignore`、`docker-compose.yml`、`.env.example`                                                                                                                    | 本机无 Docker CLI，**镜像未实际构建**——CI `docker.yml` 的 build+smoke 是首次验证点                                                |
| P5 Actions      | `.github/workflows/docker.yml`：PR 构建 amd64 + Trivy(HIGH/CRITICAL 阻断) + 容器冒烟（healthz / 401 / readyz / 带 token initialize）；tag `v*` 多架构推 GHCR + provenance/SBOM                                          | YAML 已用解析器校验；冒烟的 initialize 探针经本机双服务器 curl 实测（legacy `2025-03-03` 与协商版本均返回 200），采用 legacy 报文 |
| P6 加固         | 请求体硬上限（默认 16 MiB，env `MCP_MAX_BODY_BYTES`）、按 token 摘要的固定窗口限流（默认 120/min，env `MCP_RATE_LIMIT_PER_MINUTE`，429+`Retry-After`）、SSE keepalive 15s、日志不落 `Authorization`、绑定默认 127.0.0.1 | `src/utils/rate-limit.ts` + 集成测试 429 用例                                                                                     |

### 实施中对文档的修正

1. **依赖版本**：`@modelcontextprotocol/node@2.1.1` 的 peer 要求 `server@^2.3.0`，server 升至 2.3.1、client 升至 2.3.1（详见 Phase 0 注记）。
2. **legacy 取值**：HTTP 侧是 `'stateless' | 'reject'`，不是 `--legacy serve` 的 `serve|reject`，已做映射。
3. **fail-fast 令牌策略**：`--http` 无 `MCP_AUTH_TOKEN` 直接拒绝启动（`HTTP_AUTH_TOKEN_MISSING`），本地开发逃生门为 `MCP_ALLOW_UNAUTHENTICATED=1`（启动打 warning 诊断）。令牌最短 32 字符由 zod 校验。
4. **MCP 端点路径**：容器内任意路径都进 MCP handler（`createMcpHandler` 本身路径无关），`/mcp` 只是反代侧约定；`/healthz`、`/readyz` 除外。
5. **恢复工具的 vault 维度**：MCP 工具带 `vault` 参数，不受 CLI `recovery restore` 的"恰好 1 个 vault"限制。
6. **探针限流例外**：`/healthz`、`/readyz` 在限流之前应答（编排器高频探测不消耗业务配额），但 Host/Origin 校验仍在最前，防止经 DNS-rebound 名称探测内网存活。

### 已定的部署决策（2026-10-10 用户确认）

- 反向代理：**Caddy**，示例配置 `deploy/caddy/Caddyfile`（`network_mode: host`，compose 注释含启用块）。注意不可在反代重写 Host 头，否则触发本服务的 DNS-rebinding 校验。
- GHCR 命名空间：**保持 `github.repository` 模板推导**，fork 改名后 workflow 自动跟随；`package.json` 的 `repository`/`author` 字段暂不改（属上游归属信息，改名时一并处理）。
- stdio 向后兼容：**保留**，为默认传输。

### 未做 / 待决

- **P2b OAuth 2.1**（claude.ai / ChatGPT 自定义连接器）：需先选定外部授权服务器（Keycloak/Logto/Authentik/Auth0），SDK 资源服务器构件已在 `server` 包中就位（`oauthMetadataResponse`、`getOAuthProtectedResourceMetadataUrl`），代码入口在 `src/http.ts` 留待接入。
- **GHCR 命名空间**：`package.json` 的 `repository`/`author` 仍指向上游 `StevenStavrakis/obsidian-mcp`，镜像名由 `github.repository` 推导——fork 改名后 `docker.yml` 自动跟随，但需人工确认发布命名。
- 文档 Phase 0 的远端检查（`docker inspect` webdav 挂载、UID 对齐、`.obsidian` 存在性）需在目标服务器上执行。
