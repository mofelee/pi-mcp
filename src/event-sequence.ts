// 同一毫秒内也能稳定排序：工具开始事件与 HTTP 日志共用单调序号。
let sequence = 0;
export function nextEventSequence(): number { return ++sequence; }
