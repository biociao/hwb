// Node 的 setTimeout/setInterval 延时上限是 2^31-1：**超过它不会报错**，
// 而是打印一行 TimeoutOverflowWarning 后按 1ms 处理 —— 于是「把间隔调大」变成「每秒上千轮空转」。
// 任何会被喂给定时器的用户输入都必须夹在这个上限内。实测：HWB_DIR=… hwb config set intervalMs 1e16
// 曾原样通过校验，服务随后以 1ms 的节奏跑索引与心跳。
export const MAX_TIMER_MS = 2 ** 31 - 1;   // ≈ 24.8 天
