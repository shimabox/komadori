export interface DropzoneCallbacks {
  onFileSelected: (file: File) => void;
}

export interface DropzoneHandle {
  element: HTMLElement;
  /** 選択中のファイル名を表示する(未選択なら null) */
  setFileName(name: string | null): void;
}

const ACCEPT_ATTR = 'video/*,.mp4,.webm,.mov,.m4v,.avi,.mkv,.ogv,image/gif,.gif';

/** ドラッグ&ドロップ + クリックでのファイル選択エリアを作る */
export function createDropzone(callbacks: DropzoneCallbacks): DropzoneHandle {
  const element = document.createElement('section');
  element.className = 'dropzone';
  element.tabIndex = 0;
  element.setAttribute('role', 'button');
  element.setAttribute('aria-label', '動画・GIF ファイルを選択');

  const message = document.createElement('p');
  message.className = 'dropzone-message';
  message.innerHTML = 'ここに動画・GIF ファイルをドラッグ&ドロップ<br />またはクリックして選択';

  const hint = document.createElement('p');
  hint.className = 'dropzone-hint';
  hint.textContent = 'mp4 / webm / mov などの動画、または gif に対応しています';

  const fileNameEl = document.createElement('p');
  fileNameEl.className = 'dropzone-filename';

  const input = document.createElement('input');
  input.type = 'file';
  input.accept = ACCEPT_ATTR;
  input.hidden = true;

  element.append(message, hint, fileNameEl, input);

  function handleFiles(files: FileList | null): void {
    if (!files || files.length === 0) {
      return;
    }
    const file = files[0];
    callbacks.onFileSelected(file);
  }

  element.addEventListener('click', () => {
    input.click();
  });
  element.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      input.click();
    }
  });

  input.addEventListener('change', () => {
    handleFiles(input.files);
    // 同じファイルを連続で選択してもイベントが発火するようにする
    input.value = '';
  });

  let dragDepth = 0;
  element.addEventListener('dragenter', (event) => {
    event.preventDefault();
    dragDepth += 1;
    element.classList.add('dropzone--dragover');
  });
  element.addEventListener('dragover', (event) => {
    event.preventDefault();
  });
  element.addEventListener('dragleave', (event) => {
    event.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) {
      element.classList.remove('dropzone--dragover');
    }
  });
  element.addEventListener('drop', (event) => {
    event.preventDefault();
    dragDepth = 0;
    element.classList.remove('dropzone--dragover');
    handleFiles(event.dataTransfer?.files ?? null);
  });

  function setFileName(name: string | null): void {
    fileNameEl.textContent = name ? `選択中のファイル: ${name}` : '';
  }

  return { element, setFileName };
}
