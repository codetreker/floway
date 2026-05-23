import type { Repo } from './types.ts';

let _repo: Repo | null = null;

export function initRepo(repo: Repo): void {
  _repo = repo;
}

export function getRepo(): Repo {
  if (!_repo) throw new Error('Repo not initialized — call initRepo() first');
  return _repo;
}
