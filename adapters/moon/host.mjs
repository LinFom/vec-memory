import {createMoonMemoryAdapter} from './index.mjs';
import {installInnerLifeMemory} from './inner-life.mjs';

let configuration;
let uninstall;

export function setup(api) {
  configuration = api.config;
}

export function activate() {
  if (uninstall) return;
  uninstall = installInnerLifeMemory(createMoonMemoryAdapter({...configuration(), token: process.env.MOON_VEC_MEMORY_TOKEN}));
}

export function deactivate() {
  uninstall?.();
  uninstall = undefined;
}
