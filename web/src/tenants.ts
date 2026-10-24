const KEY = 'ds_tenants';
const listeners = new Set<() => void>();

// 登录态租户：一个用户可以属于多个租户，存在本地并随请求头 X-Tenants 带给后端。
// 留空表示不指定租户——此时只能看到「未配置白名单」的数据源。
export function readTenants(): string[] {
  return (localStorage.getItem(KEY) || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function writeTenants(value: string[]): void {
  localStorage.setItem(KEY, value.join(','));
  listeners.forEach((fn) => fn());
}

// 租户变化后查询页要重新拉可见数据源，所以需要一个简单的订阅机制。
export function subscribeTenants(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
