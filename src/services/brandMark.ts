/**
 * The Vula mark the office's documents carry, as a PNG.
 *
 * `frontend/public/vula-mark.svg` is the single source — the browser, the tab
 * and the apps all wear it — and `vula-mark.png` beside it is the render pdfkit
 * needs (it cannot draw SVG). The file is read from wherever the app is serving
 * the SPA from, so dev runs and the built container both find it. A missing
 * asset returns null: a document must render with or without its letterhead.
 */
import fs from 'node:fs';
import path from 'node:path';

const candidates = (): string[] => {
  const paths: string[] = [
    path.join(process.cwd(), 'frontend', 'public', 'vula-mark.png'),
    path.join(process.cwd(), 'frontend', 'dist', 'vula-mark.png'),
  ];
  // Mirrors app.ts's SPA lookup: module-relative first when the runtime offers
  // `__dirname`, then cwd-relative (the container's WORKDIR).
  if (typeof __dirname !== 'undefined') {
    paths.push(path.join(__dirname, '..', '..', 'frontend', 'public', 'vula-mark.png'));
    paths.push(path.join(__dirname, '..', '..', 'frontend', 'dist', 'vula-mark.png'));
  }
  return paths;
};

let cached: Buffer | null | undefined;

/** The PNG bytes, read once. Null when the asset is not beside the app. */
export const brandMarkPng = (): Buffer | null => {
  if (cached !== undefined) return cached;
  cached = null;
  for (const candidate of candidates()) {
    try {
      cached = fs.readFileSync(candidate);
      break;
    } catch {
      // Try the next candidate.
    }
  }
  return cached;
};
