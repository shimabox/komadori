export type NoticeLevel = 'error' | 'warning' | 'info';

export interface NoticeHandle {
  element: HTMLElement;
  /** メッセージを1件追加する(複数件を同時に表示できる) */
  add(level: NoticeLevel, message: string): void;
  /** 表示中のメッセージをすべて消す */
  clear(): void;
}

/** エラー・警告などのメッセージを表示する領域を作る */
export function createNotice(): NoticeHandle {
  const element = document.createElement('div');
  element.className = 'notice-area';

  function add(level: NoticeLevel, message: string): void {
    const item = document.createElement('div');
    item.className = `notice notice--${level}`;
    item.setAttribute('role', level === 'error' ? 'alert' : 'status');
    item.textContent = message;
    element.append(item);
  }

  function clear(): void {
    element.replaceChildren();
  }

  return { element, add, clear };
}
