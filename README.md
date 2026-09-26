# ocber-router

OpenChamber 扩展：把 [dsh-router](https://github.com/CARVIN94/dsh-router) 的
**OpenAI 兼容路由核心**与 [dsh-router-codebuddy](https://github.com/CARVIN94/dsh-router-codebuddy)
的 **CodeBuddy 族供应商**合并成一个原生 OpenChamber 扩展（面板 + 本地服务）。

装好之后，OpenChamber 里多一个侧栏面板，同时本机多一个 OpenAI 兼容端点：

```
http://127.0.0.1:3080/v1
```

任何支持 OpenAI 兼容 API 的客户端（Claude Code、Cline、OpenCode 自定义 provider 等）
把 `baseURL` 指过去即可；面板里管理 CodeBuddy / WorkBuddy 账号、模型、组合与密钥。

> 与 DSH 无关：这里不是 DSH 插件，而是 OpenChamber 扩展（`apiVersion: 1`，
> `contributes.panel` + `contributes.service`）。上游协议、账号池策略、签到/积分
> 逻辑衍生自上面两个 MIT 项目。

## 功能

| 能力 | 说明 |
| --- | --- |
| 两个供应商 | `codebuddy`（国内 copilot.tencent.com，别名前缀 `codebuddy/`）、`codebuddy-en`（国际版 WorkBuddy，`codebuddy-en/`） |
| OAuth 轮询登录 | 面板生成登录链接 → 浏览器登录 → 服务后台轮询换 token（每 5s，最多 5 分钟） |
| 账号池 | 按会话前缀亲和选号（同一会话固定同一连接），失败按语义冷却/退避，逐个回退 |
| 模型管理 | 从上游 `GET /v3/config` 拉取模型，可逐个启用/停用、加自定义模型 |
| 组合 | 自定义 fallback 链，建好即出现在 `/v1/models`，可直接当模型名用 |
| 签到 / 积分 | 一键签到所有账号，面板显示剩余积分（核心持久化，重启不丢） |
| OpenAI 端点 | `/v1/models`、`/v1/chat/completions`（流式透传 + 非流式聚合），可选 API Key 鉴权 |
| 用量看板 | 今日 / 24 小时 / 7 天 / 30 天，请求数、成功率、token、耗时、Top 榜、最近请求 |

## 安装

需要 OpenChamber **≥ 2.0.0**（`contributes.service` 本地服务机制），Web 或桌面端。

```bash
git clone https://github.com/leoporoluo/ocber-router.git
cd ocber-router
npm install
npm run build        # 产出 panel/main.js 与 service/main.js
```

然后 **设置 → 扩展 → Add**，填入本仓库目录的绝对路径，批准它申请的 `service`
能力（服务以你的用户权限运行，用来访问 CodeBuddy 上游）。

> 也可以直接填本仓库的 GitHub 地址安装（仓库已提交构建产物）。git 安装的副本
> 在 OpenChamber 数据目录里，升级需在设置里点 Update。

## 使用

1. **首次使用请打开一次面板**。扩展的本地服务由宿主在第一次请求时拉起；
   面板打开即触发。之后服务常驻，直到 OpenChamber 退出。
2. 面板 → **供应商** → `CodeBuddy` / `CodeBuddyEN` → **添加链接** → 浏览器登录。
3. **获取模型** → 逐个启用需要的模型（默认全开）。
4. 在 **端点与密钥** 复制端点（默认 `http://127.0.0.1:3080/v1`），配置你的客户端：

```bash
curl http://127.0.0.1:3080/v1/models

curl -X POST http://127.0.0.1:3080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"codebuddy/glm-5.3","messages":[{"role":"user","content":"你好"}],"stream":false}'
```

模型名可以是 `别名/模型id`（精确指定供应商）、无歧义的裸模型名，或组合名。
一个供应商只有一个账号时，裸名与 `别名/模型` 等价。

### 在 OpenCode / OpenChamber 里用

OpenChamber 自带 OpenCode，可把本端点注册成自定义 provider（`opencode.json`）：

```jsonc
{
  "provider": {
    "ocber": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "OCBer Router",
      "options": { "baseURL": "http://127.0.0.1:3080/v1" },
      "models": {
        "codebuddy/glm-5.3": { "name": "GLM-5.3 (CodeBuddy)" },
        "codebuddy-en/gpt-5.5": { "name": "GPT-5.5 (WorkBuddy)" }
      }
    }
  }
}
```

（`requireApiKey` 打开后，在 provider 的 `options.apiKey` 填面板里创建的 Key。）

## 行为边界（先读这一段）

- **服务随 OpenChamber 启停**，不是常驻守护进程：OpenChamber 退出后端点不可用；
  重新打开后需再打开一次面板把它拉起来。宿主没有给扩展「开机自启」的角色。
- **面板与服务的单次调用有 20s 超时、256KB 响应上限**，所以登录轮询、签到、
  拉模型都在服务里跑后台任务，面板只轮询进度。
- **对外端口默认 3080**，被占用会自动顺延（面板显示实际端口），可在面板改。
  只监听 `127.0.0.1`。
- 面板是沙箱 iframe，不直连外网；所有上游请求、凭证都在本地服务进程里。

## 数据目录

`~/.ocber-router/`（可用 `OCBER_DATA_DIR` 覆盖）：

```
credentials.json       供应商凭证（不透明 blob）
supplier-config.json   别名 / 模型启停 / 池顺序 / 积分缓存
combos.json            组合
keys.json              API Keys + requireApiKey
usage.json             用量统计
settings.json          对外端口
```

删除 `credentials.json` 等于退出所有账号；删除 `usage.json` 只是清掉统计。

## 开发

```bash
npm install
npm run typecheck        # tsc --noEmit
npm run build            # bunx openchamber-guest-bundle（面板 IIFE + 服务 Node bundle）
node scripts/validate.mjs  # 模拟「设置 → 扩展」的清单/产物自检
node scripts/smoke.mjs     # 拉起服务，验证管理鉴权 / /api/state / /v1/models / 404
```

源码结构：

```
panel/main.ts                     面板（@openchamber/sdk + /ui，中文优先）
service/main.ts                   服务入口（宿主注入 PORT/TOKEN）
src/service/app.ts                运行时状态：供应商、目录、任务
src/service/server.ts             两个回环监听 + 鉴权
src/service/chat.ts               OpenAI 兼容对话管线（SSE 透传/聚合）
src/service/admin.ts              面板管理 API
src/service/account-pool.ts       选号 / 冷却 / 亲和
src/service/store.ts              JSON 持久化
src/service/usage.ts              用量统计
src/service/suppliers/codebuddy/  供应商实现（衍生自 dsh-router-codebuddy）
```

## 致谢与许可

MIT。衍生自：

- [CARVIN94/dsh-router](https://github.com/CARVIN94/dsh-router) —— 路由核心、账号池、用量与密钥设计；
- [CARVIN94/dsh-router-codebuddy](https://github.com/CARVIN94/dsh-router-codebuddy) —— CodeBuddy 族供应商实现（`src/service/suppliers/codebuddy/` 直接移植）。

参考项目：[decolua/9router](https://github.com/decolua/9router)、
[openchamber/openchamber](https://github.com/openchamber/openchamber) 的扩展体系，
以及 [airtaxi/openchamber-tps](https://github.com/airtaxi/openchamber-tps) 的
panel+service 范例。

仅用于学习与技术研究，请勿用于商业用途。
