// 登录态：token 放 localStorage，身份由 /auth/me 返回。
//
// 这个平台不自己管账号——真实环境由企业 IdP 下发 JWT，本服务只验签。
// 所以这里没有「用户资料」「改密码」「记住我」这类东西，只有一个 token 和一个身份。

export type AuthMode = 'off' | 'dev' | 'jwt';

export interface Identity {
  user: string;
  tenants: string[];
  visible_users: string[];
  roles: string[];
}

export interface AuthModeInfo {
  mode: AuthMode;
  need_login: boolean;
  // dev：登录页列预置身份让人点；sso：跳企业登录页；''：不用登录
  login_kind: '' | 'dev' | 'sso';
  sso_url: string;
  identities: Identity[];
}

export interface MeInfo {
  mode: AuthMode;
  identity: Identity;
  editor: boolean;
}

const TOKEN_KEY = 'ds_token';

export function getToken(): string {
  return localStorage.getItem(TOKEN_KEY) || '';
}

export function setToken(token: string): void {
  if (token) {
    localStorage.setItem(TOKEN_KEY, token);
  } else {
    localStorage.removeItem(TOKEN_KEY);
  }
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

// 401 的处理权交给 App：只有它知道该跳哪里。
// 这里用回调而不是直接改 location，是为了让「接口层」不依赖「路由层」。
type UnauthorizedHandler = () => void;
let unauthorizedHandler: UnauthorizedHandler | null = null;

export function setUnauthorizedHandler(fn: UnauthorizedHandler | null): void {
  unauthorizedHandler = fn;
}

export function notifyUnauthorized(): void {
  if (unauthorizedHandler) unauthorizedHandler();
}
