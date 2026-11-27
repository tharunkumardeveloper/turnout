// Turns a recording from record.mjs into a smooth GIF: the moments around each mark at normal speed, the waits in
// between fast-forwarded, a steady frame rate and one palette for the whole clip. Needs Docker (ffmpeg's image).
//   node docs/images/readme/source/gif.mjs <dir> <clip> <out.gif> [width=800] [fps=12]
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';

const [dir, clip, outGif, width = '800', fps = '12'] = process.argv.slice(2);
const { marks, end } = JSON.parse(readFileSync(resolve(dir, `${clip}.json`), 'utf8'));
const BEFORE = 1.0; // seconds before a mark, at normal speed
const AFTER = 2.5; // and after it
const FAST = 10; // the waits in between play this much faster

// Normal-speed windows around the marks, merged where they overlap; the last one runs to the end (the result).
const windows = [];
for (const [i, m] of marks.entries()) {
  const a = Math.max(0, m.t - BEFORE);
  const b = Math.min(end, m.t + (i === marks.length - 1 ? 6 : AFTER)); // the result stays a little longer
  const last = windows.at(-1);
  if (last && a <= last[1]) last[1] = Math.max(last[1], b);
  else windows.push([a, b]);
}
const segments = [];
let at = Math.max(0, windows[0][0] - 1.5); // a moment of the page before the first click
for (const [a, b] of windows) {
  if (a - at > 0.3) segments.push([at, a, FAST]);
  segments.push([Math.max(at, a), b, 1]);
  at = b;
}

const parts = segments.map(([a, b, speed], i) => `[0:v]trim=start=${a.toFixed(2)}:end=${b.toFixed(2)},setpts=(PTS-STARTPTS)/${speed}[s${i}]`);
const graph = `${parts.join(';')};${segments.map((_, i) => `[s${i}]`).join('')}concat=n=${segments.length}:v=1:a=0[c];` +
  `[c]fps=${fps},scale=${width}:-1:flags=lanczos,split[x][y];[x]palettegen=max_colors=128:stats_mode=diff[p];[y][p]paletteuse=dither=none:diff_mode=rectangle`;

const inDir = resolve(dir);
const outDir = resolve(dirname(outGif));
execFileSync('docker', ['run', '--rm', '-v', `${inDir}:/in`, '-v', `${outDir}:/out`, 'jrottenberg/ffmpeg:7.1-alpine', '-v', 'error', '-y',
  '-i', `/in/${clip}.webm`, '-filter_complex', graph, '-loop', '0', `/out/${basename(outGif)}`], { stdio: 'inherit', env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
const length = segments.reduce((s, [a, b, speed]) => s + (b - a) / speed, 0);
console.log(`${basename(outGif)}: ${length.toFixed(1)} s at ${fps} fps, ${(statSync(outGif).size / 1024).toFixed(0)} KB`);
