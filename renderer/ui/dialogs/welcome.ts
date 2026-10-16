import playerHeadIcon from '../../../resources/player_head.svg';
import { closeWithAnimation, openWithAnimation } from '../common/ui-open-close.js';

let inputLocked = true;
let dialog: HTMLDialogElement | undefined;

// Load before editor handlers; a native modal alone cannot block window capture handlers or file drops.
const inputEvents = ['keydown', 'keyup', 'pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'mousedown', 'mousemove', 'mouseup', 'click', 'dblclick', 'auxclick', 'contextmenu', 'wheel', 'touchstart', 'touchmove', 'touchend', 'dragstart', 'dragenter', 'dragleave', 'dragover', 'drop', 'paste', 'copy', 'cut', 'beforeinput'];
for (const name of inputEvents) {
  window.addEventListener(name, event => {
    if (!inputLocked) return;
    const fileDrop = event instanceof DragEvent && event.dataTransfer?.types.includes('Files');
    if (dialog?.open && dialog.contains(event.target as Node) && !fileDrop) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, { capture: true, passive: false });
}

export async function waitForWelcome(): Promise<void> {
  try {
    if (localStorage.getItem('pdeOnboardingCompleted') === 'true') {
      inputLocked = false;
      return;
    }
  } catch { /* A failed read still requires consent and a successful completion write. */ }

  dialog = document.createElement('dialog');
  dialog.className = 'welcome-overlay';
  dialog.setAttribute('aria-labelledby', 'welcome-title');
  dialog.innerHTML = `
    <section class="settings-window welcome-window">
      <h1 id="welcome-title">Pangch Display Editor에 오신 것을 환영합니다!</h1>
      <nav class="settings-nav welcome-nav" aria-label="시작 설정">
        <button type="button" data-welcome-page="general"><span class="lucide-icon" aria-hidden="true">&#xE30B;</span>일반 설정</button>
        <button type="button" data-welcome-page="shortcuts"><span class="lucide-icon" aria-hidden="true">&#xE284;</span>단축키</button>
      </nav>
      <footer>
        <div class="welcome-consent">
          <p>PDE를 이용하시려면 동의가 필요합니다.</p>
          <div><input id="welcome-eula" type="checkbox" aria-labelledby="welcome-eula-label"><span id="welcome-eula-label"><label for="welcome-eula">나는 </label><a href="https://www.minecraft.net/ko-kr/eula">Minecraft 최종 사용자 라이선스 계약(“EULA”)에 동의합니다.</a></span></div>
        </div>
        <button class="project-ui-button welcome-start" type="button" disabled><img src="${playerHeadIcon}" alt="">시작</button>
      </footer>
      <p class="welcome-error" role="alert" hidden></p>
    </section>
  `;
  const welcomeWindow = dialog.querySelector<HTMLElement>('.welcome-window')!;
  const checkbox = dialog.querySelector<HTMLInputElement>('#welcome-eula')!;
  const startButton = dialog.querySelector<HTMLButtonElement>('.welcome-start')!;
  const errorMessage = dialog.querySelector<HTMLElement>('.welcome-error')!;
  const showError = (message: string) => {
    errorMessage.textContent = message;
    errorMessage.hidden = !message;
  };
  checkbox.addEventListener('change', () => { startButton.disabled = !checkbox.checked; });
  dialog.querySelector<HTMLAnchorElement>('a')!.addEventListener('click', async event => {
    event.preventDefault();
    try {
      const result = await window.ipcApi.openMinecraftEula();
      showError(result.success ? '' : `EULA를 열지 못했습니다: ${result.error ?? '알 수 없는 오류'}`);
    } catch (error) { showError(`EULA를 열지 못했습니다: ${String(error)}`); }
  });
  for (const button of dialog.querySelectorAll<HTMLButtonElement>('[data-welcome-page]')) {
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        const { openSettings } = await import('../settings/setting');
        if (welcomeWindow.hidden || welcomeWindow.inert) return;
        const settingsOverlay = openSettings({
          initialPage: button.dataset.welcomePage as 'general' | 'shortcuts',
          fromWelcome: true,
          onClose: () => {
            document.body.append(settingsOverlay);
            welcomeWindow.hidden = false;
            dialog!.setAttribute('aria-labelledby', 'welcome-title');
            openWithAnimation(welcomeWindow);
            button.focus();
          }
        });
        dialog!.append(settingsOverlay);
        welcomeWindow.hidden = true;
        dialog!.setAttribute('aria-labelledby', 'settings-title');
        settingsOverlay.querySelector<HTMLButtonElement>('.settings-close')!.focus();
      } catch (error) { showError(`설정을 열지 못했습니다: ${String(error)}`); }
      finally { button.disabled = false; }
    });
  }
  dialog.addEventListener('cancel', event => event.preventDefault());
  for (const name of inputEvents) dialog.addEventListener(name, event => {
    if (event instanceof KeyboardEvent && event.key === 'Escape') event.preventDefault();
    if (event instanceof KeyboardEvent && event.type === 'keydown' && event.key === 'Tab') {
      const controls = [...dialog!.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]')]
        .filter(element => element.getClientRects().length && !element.closest('[inert]'));
      const first = controls[0], last = controls[controls.length - 1];
      if (document.activeElement === (event.shiftKey ? first : last)) {
        event.preventDefault();
        (event.shiftKey ? last : first)?.focus();
      }
    }
    event.stopPropagation();
  });
  document.body.append(dialog);
  dialog.showModal();
  openWithAnimation(welcomeWindow);
  dialog.querySelector<HTMLButtonElement>('[data-welcome-page]')!.focus();

  await new Promise<void>(resolve => {
    startButton.addEventListener('click', async () => {
      if (!checkbox.checked || startButton.disabled) return;
      try { localStorage.setItem('pdeOnboardingCompleted', 'true'); }
      catch (error) {
        showError(`시작 상태를 저장하지 못했습니다. 다시 시도해 주세요: ${String(error)}`);
        return;
      }
      startButton.disabled = true;
      welcomeWindow.inert = true;
      await closeWithAnimation(welcomeWindow);
      dialog!.close();
      dialog!.remove();
      dialog = undefined;
      window.dispatchEvent(new Event('blur'));
      inputLocked = false;
      resolve();
    });
  });
}
