const GIF_EXTENSION = /\.gif$/i;
const VIDEO_EXTENSION = /\.(mp4|webm|mov|m4v|avi|mkv|ogv|ogg)$/i;

export type FileKind = 'gif' | 'video' | 'unknown';

export function detectFileKind(file: File): FileKind {
  if (file.type === 'image/gif' || GIF_EXTENSION.test(file.name)) {
    return 'gif';
  }
  if (file.type.startsWith('video/') || VIDEO_EXTENSION.test(file.name)) {
    return 'video';
  }
  return 'unknown';
}

export function stripExtension(filename: string): string {
  const idx = filename.lastIndexOf('.');
  return idx > 0 ? filename.slice(0, idx) : filename;
}

export function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(1)}MB`;
}

export function formatFileTimestamp(ms: number): string {
  const totalMs = Math.max(0, Math.round(ms));
  const minutes = Math.floor(totalMs / 60000);
  const seconds = Math.floor((totalMs % 60000) / 1000);
  const millis = totalMs % 1000;
  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');
  const mss = String(millis).padStart(3, '0');
  return `${mm}m${ss}s${mss}`;
}

/** ファイル名規則: {4桁ゼロ埋め連番}_{mm}m{ss}s{ミリ秒3桁}.png */
export function buildFrameFileName(sequence: number, timestampMs: number): string {
  const seq = String(sequence).padStart(4, '0');
  return `${seq}_${formatFileTimestamp(timestampMs)}.png`;
}
