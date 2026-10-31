// 大盘的个人使用痕迹：星标（常用置顶）与最近打开时间。
//
// 存 localStorage 而不是后端：这是「我」的使用习惯，不是大盘的属性。
// 张三常用质检日报、李四常用采集日报，写进库里反而变成要协调的配置了。
import dayjs from 'dayjs';

const KEY = 'dashboard:usage';

export interface DashUsage {
  pinned?: boolean;
  ts?: number;
}

export function loadUsage(): Record<string, DashUsage> {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Record<string, DashUsage>) : {};
  } catch {
    return {};
  }
}

function saveUsage(u: Record<string, DashUsage>) {
  try {
    localStorage.setItem(KEY, JSON.stringify(u));
  } catch {
    /* 存储不可用就放弃，列表退回原始顺序 */
  }
}

// 打开大盘时记一笔：列表要拿它做「最近打开」的排序与展示
export function markOpened(key: string) {
  if (!key) return;
  const u = loadUsage();
  u[key] = { ...u[key], ts: Date.now() };
  saveUsage(u);
}

// 星标切换，返回切换后是否为置顶
export function togglePinned(key: string): boolean {
  const u = loadUsage();
  const pinned = !u[key]?.pinned;
  u[key] = { ...u[key], pinned };
  saveUsage(u);
  return pinned;
}

// 「今天 18:02 / 昨天 10:11 / 10-29」——列表里一眼能读出「多久没看」的粒度
export function fmtUsedAt(ts?: number): string | null {
  if (!ts) return null;
  const d = dayjs(ts);
  const today = dayjs();
  if (d.isSame(today, 'day')) return `今天 ${d.format('HH:mm')}`;
  if (d.isSame(today.subtract(1, 'day'), 'day')) return `昨天 ${d.format('HH:mm')}`;
  return d.format('MM-DD');
}
