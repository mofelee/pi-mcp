import { ProcessTerminal } from "@earendil-works/pi-tui";

/** Pi 的终端输入/清理照常工作，但禁止 PI_TUI_WRITE_LOG 将画面复制到磁盘。 */
export class MemoryLogTerminal extends ProcessTerminal {
  override write(data: string): void {
    process.stdout.write(data);
  }
}
