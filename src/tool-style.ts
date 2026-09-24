// 操作类别只做视觉区分，不增加确认流程，也不改变工具权限声明。
const TOOL_STYLES: Record<string, { code: number; label: string }> = {
  write: { code: 36, label: "写入" },
  edit: { code: 33, label: "编辑" },
  bash: { code: 35, label: "命令" },
};

export function styleToolName(name: string, color = !process.env.NO_COLOR): string {
  const style = TOOL_STYLES[name];
  if (!style) return name;
  const text = `${name} [${style.label}]`;
  return color ? `\x1b[${style.code}m${text}\x1b[0m` : text;
}
