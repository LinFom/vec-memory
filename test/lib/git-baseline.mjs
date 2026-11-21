import {spawnSync} from 'node:child_process';

// Scope these checks to the original feature range. Later releases can update
// the same storage files for independent features.
export function changedDuring(root, paths, start, end) {
  const git = args => spawnSync('git', args, {cwd: root, encoding: 'utf8'});
  if ([start, end].some(ref => git(['rev-parse', '--verify', '--quiet', ref + '^{commit}']).status !== 0)) {
    return {base: null, files: [], error: null};
  }
  const diff = git(['diff', '--name-only', start, end, '--', ...paths]);
  if (diff.status !== 0) return {base: start, files: [], error: String(diff.stderr || diff.error?.message || 'git diff failed').trim()};
  return {base: start, files: diff.stdout.trim().split('\n').filter(Boolean), error: null};
}
