// 必须先补齐内嵌配置，再定位 Pi 资源，最后加载会读取环境变量的业务模块。
import "./src/env";
import "./src/pi/runtime-dir";
import { server } from "./src/server";
import { RESOURCE } from "./src/config";
import { serviceShutdown } from "./src/lifecycle";
import { CWD } from "./src/pi/environment";
import { startToolMonitor } from "./src/monitor/start";
import { toolActivities } from "./src/monitor/store";

let stopping = false;
async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  serviceShutdown.abort();
  void server.stop(true);
  // 给 Pi 的取消处理器一个有界的清理窗口。
  const deadline = Date.now() + 2000;
  while (toolActivities.running.length && Date.now() < deadline) await Bun.sleep(25);
  monitor?.stop();
  process.exit(0);
}

const monitor = await startToolMonitor({ cwd: CWD, endpoint: RESOURCE, onExit: () => { void shutdown(); } });
process.once("SIGINT", () => { void shutdown(); });
process.once("SIGTERM", () => { void shutdown(); });
process.once("exit", () => monitor?.stop());
