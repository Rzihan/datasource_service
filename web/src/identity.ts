const TENANT_KEY = 'ds_tenants';
const VISIBLE_USER_KEY = 'ds_visible_users';

const tenantListeners = new Set<() => void>();
const visibleUserListeners = new Set<() => void>();

// 登录态身份：一个用户可以属于多个租户，也可以代看若干用户的数据。
// 两者都存在本地，随请求头 X-Tenants / X-Visible-Users 带给后端：
//   X-Tenants      → 数据源级 / 列级租户白名单命中判断
//   X-Visible-Users → 行级过滤里 user 规则的取值来源
// 留空表示「没有身份」，按 fail-closed 策略：开了行级过滤的数据源会直接查不到数据。
function readList(key: string): string[] {
  return (localStorage.getItem(key) || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function writeList(key: string, value: string[], listeners: Set<() => void>): void {
  if (value.length === 0) {
    localStorage.removeItem(key);
  } else {
    localStorage.setItem(key, value.join(','));
  }
  listeners.forEach((fn) => fn());
}

function subscribe(listeners: Set<() => void>, fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function readTenants(): string[] {
  return readList(TENANT_KEY);
}

export function writeTenants(value: string[]): void {
  writeList(TENANT_KEY, value, tenantListeners);
}

// 租户变化后查询页要重新拉可见数据源，所以需要订阅。
export function subscribeTenants(fn: () => void): () => void {
  return subscribe(tenantListeners, fn);
}

export function readVisibleUsers(): string[] {
  return readList(VISIBLE_USER_KEY);
}

export function writeVisibleUsers(value: string[]): void {
  writeList(VISIBLE_USER_KEY, value, visibleUserListeners);
}

export function subscribeVisibleUsers(fn: () => void): () => void {
  return subscribe(visibleUserListeners, fn);
}
