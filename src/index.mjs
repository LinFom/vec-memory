// index.mjs — 本仓**唯一公共入口**
//
// 纪律（同 core/factstore 的 `openFactStore`）：装配句柄只留一个入口。
// 想用本仓的能力，只从这里 import —— 别直接够 `src/core/*`，
// 否则将来换传输/换存储时，会有一批「外部直接依赖内部形状」的调用点收不回来。
export { createRouter } from './transport/inproc.mjs';
export { handleMemoryVec } from './router.mjs';
export { bindHost, hostBound, resetHost } from './core/host.mjs';
export * as core from './core/backend.mjs';

export { createService } from './standalone/service.mjs';
export { createStandaloneServer } from './standalone/server.mjs';
