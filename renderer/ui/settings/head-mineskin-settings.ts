import type { MineSkinKey } from '../../player-head-service/head-texture-types';

export function initMineSkinSettings(root: HTMLElement): void {
  const api = window.ipcApi?.headTextures;
  const list = root.querySelector<HTMLElement>('.settings-mineskin-list')!;
  const add = root.querySelector<HTMLButtonElement>('.settings-mineskin-add')!;
  const status = root.querySelector<HTMLElement>('.settings-mineskin-status')!;
  if (!api?.mineSkinKeys) {
    add.disabled = true;
    status.textContent = 'MineSkin 키 설정을 연결하려면 PDE 데스크톱 앱을 다시 시작해 주세요.';
    return;
  }
  let keys: MineSkinKey[] = [];
  let running = false;
  let changing = true;
  const visible = new Set<string>();
  const lock = () => {
    add.disabled = running || changing;
    list.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input, .settings-mineskin-remove').forEach(control => { control.disabled = running || changing; });
  };
  const render = (entries: MineSkinKey[]) => {
    keys = entries;
    list.replaceChildren(...entries.map(entry => {
      const row = document.createElement('div');
      row.className = 'settings-mineskin-row'; row.dataset.id = entry.id;
      const label = document.createElement('label');
      const input = document.createElement('input');
      input.id = `mineskin-${entry.id}`; label.htmlFor = input.id; label.textContent = 'api :';
      input.value = entry.key; input.maxLength = 512; input.autocomplete = 'off'; input.spellcheck = false;
      input.ariaLabel = 'MineSkin API 키';
      const eye = document.createElement('button');
      eye.type = 'button'; eye.className = 'settings-mineskin-eye lucide-icon';
      const mask = () => {
        const shown = visible.has(entry.id);
        input.type = shown ? 'text' : 'password';
        eye.textContent = shown ? '\uE0BA' : '\uE0BB';
        eye.ariaLabel = eye.title = shown ? 'MineSkin API 키 숨기기' : 'MineSkin API 키 표시';
        eye.setAttribute('aria-pressed', String(shown));
      };
      eye.onclick = () => { visible.has(entry.id) ? visible.delete(entry.id) : visible.add(entry.id); mask(); };
      mask();
      const remove = document.createElement('button');
      remove.type = 'button'; remove.className = 'settings-mineskin-remove lucide-icon';
      remove.textContent = '\uE18E'; remove.ariaLabel = remove.title = 'MineSkin API 키 삭제';
      remove.onclick = () => { void change(() => api.removeMineSkinKey(entry.id)); };
      input.onchange = () => { void change(() => api.updateMineSkinKey(entry.id, input.value)); };
      input.onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); input.blur(); } };
      row.append(label, input, eye, remove);
      return row;
    }));
    lock();
  };
  const change = async (action: () => Promise<MineSkinKey[]>, focusNew = false) => {
    if (running || changing) return;
    changing = true; lock(); status.textContent = '';
    try {
      render(await action());
    } catch (error) { render(keys); status.textContent = error instanceof Error ? error.message : String(error); }
    finally {
      changing = false; lock();
      if (focusNew) list.lastElementChild?.querySelector<HTMLInputElement>('input')?.focus();
    }
  };
  add.onclick = () => { void change(() => api.addMineSkinKey(), true); };
  lock();
  void Promise.all([api.mineSkinKeys(), api.state()]).then(([entries, state]) => {
    running = state.running; render(entries);
  }).catch(error => { status.textContent = String(error); }).finally(() => { changing = false; lock(); });
  const unsubscribe = api.subscribe(event => { if (event.state) { running = event.state.running; lock(); } });
  window.addEventListener('beforeunload', unsubscribe, { once: true });
}
