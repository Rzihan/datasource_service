import { useSyncExternalStore } from 'react';

// 界面档位。同一个看板要服务两种人：
//   · 第一次打开的人需要「这个字段是什么意思、作者建议怎么看」；
//   · 每天用的人已经有自己的一套看法，这些东西全是噪音，
//     他要的是更多的数据、更少的解释。
//
// 所以不做「关掉某个功能」的散落开关，而是给一个档位：
// 简洁 = 只留核心，把所有「教学性内容」（口径说明、推荐提示、迷你趋势线、
// 预置分析列表、体检卡明细）收起来；完整 = 全部展开。
// 档位是全局偏好而不是页面内的临时状态：没人愿意每次进页面再切一次。
export type Density = 'compact' | 'full';

export interface UIPrefs {
  density: Density;
  // 构建器「高级区」的手动开合状态。留空表示跟随档位（简洁档收起、完整档展开）。
  advancedOpen?: boolean;
}

const KEY = 'ds_ui_prefs';
const DEFAULT: UIPrefs = { density: 'full' };

let cache: UIPrefs = load();
const listeners = new Set<() => void>();

function load(): UIPrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<UIPrefs>;
    return {
      density: raw.density === 'compact' ? 'compact' : 'full',
      advancedOpen: typeof raw.advancedOpen === 'boolean' ? raw.advancedOpen : undefined,
    };
  } catch {
    return { ...DEFAULT };
  }
}

function emit() {
  listeners.forEach((fn) => fn());
}

export function getPrefs(): UIPrefs {
  return cache;
}

export function setPrefs(patch: Partial<UIPrefs>): UIPrefs {
  cache = { ...cache, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(cache));
  } catch {
    // 隐私模式 / 配额满：偏好存不下不影响查数，只在本次会话内有效
  }
  emit();
  return cache;
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function subscribePrefs(fn: () => void): () => void {
  return subscribe(fn);
}

// 用 useSyncExternalStore 而不是 useState + useEffect：
// 订阅在渲染阶段就建立，不会出现「切到简洁档后第一帧还是完整档」的闪动。
export function usePrefs(): UIPrefs {
  return useSyncExternalStore(subscribe, getPrefs, getPrefs);
}
