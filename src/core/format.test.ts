import { describe, expect, it } from 'vitest';
import {
  buildFrameFileName,
  detectFileKind,
  formatBytes,
  formatFileTimestamp,
  stripExtension,
} from './format';

function makeFile(name: string, type: string): File {
  return new File(['x'], name, { type });
}

describe('detectFileKind', () => {
  it('MIMEタイプが image/gif なら gif', () => {
    expect(detectFileKind(makeFile('sample', 'image/gif'))).toBe('gif');
  });

  it('拡張子が .gif なら gif', () => {
    expect(detectFileKind(makeFile('sample.gif', ''))).toBe('gif');
  });

  it('拡張子の大文字小文字を無視する(.GIF)', () => {
    expect(detectFileKind(makeFile('sample.GIF', ''))).toBe('gif');
  });

  it('MIMEタイプが video/ 始まりなら video', () => {
    expect(detectFileKind(makeFile('sample', 'video/mp4'))).toBe('video');
  });

  it('拡張子が .mp4 なら video', () => {
    expect(detectFileKind(makeFile('sample.mp4', ''))).toBe('video');
  });

  it('拡張子の大文字小文字を無視する(.MP4)', () => {
    expect(detectFileKind(makeFile('sample.MP4', ''))).toBe('video');
  });

  it('どちらにも当てはまらない場合は unknown', () => {
    expect(detectFileKind(makeFile('sample.txt', 'text/plain'))).toBe('unknown');
  });
});

describe('stripExtension', () => {
  it('拡張子ありなら拡張子を除く', () => {
    expect(stripExtension('movie.mp4')).toBe('movie');
  });

  it('拡張子なしならそのまま', () => {
    expect(stripExtension('movie')).toBe('movie');
  });

  it('先頭がドットの場合は拡張子とみなさない(.gitignoreのようなケース)', () => {
    expect(stripExtension('.gitignore')).toBe('.gitignore');
  });
});

describe('formatBytes', () => {
  it('小数第1位まで丸めてMB表記にする', () => {
    expect(formatBytes(1.5 * 1024 * 1024)).toBe('1.5MB');
  });

  it('0バイトは0.0MB', () => {
    expect(formatBytes(0)).toBe('0.0MB');
  });
});

describe('formatFileTimestamp', () => {
  it('0は00m00s000', () => {
    expect(formatFileTimestamp(0)).toBe('00m00s000');
  });

  it('負値は0として扱う', () => {
    expect(formatFileTimestamp(-100)).toBe('00m00s000');
  });

  it('分をまたぐ値', () => {
    expect(formatFileTimestamp(61000)).toBe('01m01s000');
  });

  it('ミリ秒3桁ゼロ埋め', () => {
    expect(formatFileTimestamp(1005)).toBe('00m01s005');
  });
});

describe('buildFrameFileName', () => {
  it('4桁ゼロ埋め連番とタイムスタンプを組み合わせる', () => {
    expect(buildFrameFileName(1, 1005)).toBe('0001_00m01s005.png');
  });

  it('連番が4桁を超えてもそのまま表示する', () => {
    expect(buildFrameFileName(12345, 0)).toBe('12345_00m00s000.png');
  });
});
