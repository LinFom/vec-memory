import {createMoonMemoryAdapter} from './index.mjs';
import {installInnerLifeMemory} from './inner-life.mjs';

let adapter;
let uninstall;

export function setup(api) {
  const config = typeof api.config === 'function' ? api.config() : api.config.all();
  adapter = createMoonMemoryAdapter({...config, token: process.env.MOON_VEC_MEMORY_TOKEN});
  activate();
}

export function activate() {
  if (!uninstall) uninstall = installInnerLifeMemory(adapter);
}

export function deactivate() {
  uninstall?.();
  uninstall = undefined;
}
