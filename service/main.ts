/**
 * ocber-router —— 本地服务进程入口。
 *
 * 由 OpenChamber 宿主按 manifest `contributes.service` 拉起，环境里给
 * `OPENCHAMBER_SERVICE_PORT` 与 `OPENCHAMBER_SERVICE_TOKEN`。服务额外在
 * 127.0.0.1 上开一个对外 OpenAI 兼容端口（默认 3080，见 settings.json）。
 *
 * 宿主退出 / SIGTERM 时落盘并退出。
 */
import { startServer } from '../src/service/server.ts'
import { App, VERSION } from '../src/service/app.ts'
import { resolveDataDir } from '../src/service/store.ts'

function log(message: string): void {
  // stderr 由宿主收进扩展日志，stdout 留空避免污染
  console.error(`[ocber-router] ${message}`)
}

async function main(): Promise<void> {
  const adminPort = Number(process.env.OPENCHAMBER_SERVICE_PORT)
  const serviceToken = process.env.OPENCHAMBER_SERVICE_TOKEN ?? ''
  if (!Number.isInteger(adminPort) || adminPort <= 0 || serviceToken === '') {
    log('缺少 OPENCHAMBER_SERVICE_PORT / OPENCHAMBER_SERVICE_TOKEN，退出')
    process.exit(1)
  }

  const dataDir = resolveDataDir()
  const app = new App(dataDir, log)
  log(`v${VERSION} starting, data=${dataDir}`)

  const server = await startServer(app, serviceToken, adminPort)
  log(`ready: admin=127.0.0.1:${adminPort} endpoint=http://127.0.0.1:${server.publicPort}/v1`)

  // 后台预热模型目录：不阻塞启动，失败静默
  app.warmupCatalog()

  let shuttingDown = false
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    log(`shutting down (${signal})`)
    try {
      await server.close()
    } catch {
      // 忽略
    }
    app.dispose()
    process.exit(0)
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}

void main().catch((err) => {
  log(`fatal: ${(err as Error).message}`)
  process.exit(1)
})
