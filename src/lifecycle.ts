// 交互界面退出和系统信号共用的取消信号，让正在执行的 Pi shell 工具有机会清理子进程。
export const serviceShutdown = new AbortController();
