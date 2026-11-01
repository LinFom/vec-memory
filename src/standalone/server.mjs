import http from 'node:http';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createService } from './service.mjs';

export function createStandaloneServer(options) {
  const service = createService(options);
  const server = http.createServer(async (req, res) => {
    const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/health') return send(200, { status: 'ok', service: 'vec-memory', protocolVersion: 1 });
      if (['/', '/standalone.html'].includes(url.pathname) && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'" });
        res.end(fs.readFileSync(fileURLToPath(new URL('../../web/standalone.html', import.meta.url)))); return;
      }
      if (req.headers.origin) {
        const expected = `${req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http'}://${req.headers.host}`;
        if (req.headers.origin !== expected) return send(403, { ok: false, code: 'ORIGIN_DENIED', error: 'Same-origin requests required' });
      }
      let body = {};
      if (req.method === 'POST' && url.pathname === '/api/v1/admin/backups' && String(req.headers['content-type']).startsWith('application/octet-stream')) {
        const token = /^Bearer (\S+)$/i.exec(req.headers.authorization || '')?.[1];
        const auth = await service.handle({method:'GET',path:'/api/v1/admin/spaces',token});
        if (auth.status !== 200) return send(auth.status,auth.body);
        const chunks=[];let size=0;
        for await (const chunk of req) {size+=chunk.length;if(size>1024*1024*1024) return send(413,{ok:false,code:'BODY_TOO_LARGE',error:'Maximum backup size is 1 GiB'});chunks.push(chunk);}
        // Passwords travel in a request header, never in a URL or access log.
        const result=await service.handle({method:'POST',path:url.pathname,token,body:{upload:Buffer.concat(chunks),password:req.headers['x-backup-password']?Buffer.from(req.headers['x-backup-password'],'base64').toString('utf8'):undefined}});
        return send(result.status,result.body);
      }
      if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
        if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) return send(415, { ok: false, code: 'JSON_REQUIRED', error: 'application/json required' });
        const chunks = []; let size = 0;
        for await (const chunk of req) { size += chunk.length; if (size > 4 * 1024 * 1024) { send(413, { ok: false, code: 'BODY_TOO_LARGE', error: 'Maximum body size is 4 MiB' }); return; } chunks.push(chunk); }
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return send(400, { ok: false, code: 'INVALID_JSON', error: 'Invalid JSON' }); }
        if (!body || typeof body !== 'object' || Array.isArray(body)) return send(400, { ok: false, code: 'INVALID_ARGUMENT', error: 'JSON object required' });
      }
      const token = /^Bearer (\S+)$/i.exec(req.headers.authorization || '')?.[1];
      const result = await service.handle({ method: req.method, path: req.url, body, token });
      if (result.binary) {res.writeHead(result.status,{'content-type':'application/octet-stream','content-disposition':`attachment; filename="${result.filename}"`,'cache-control':'no-store'});return res.end(result.binary);}
      send(result.status, result.body);
    } catch { if (!res.headersSent) send(500, { ok: false, code: 'INTERNAL_ERROR', error: 'Internal service error' }); else res.end(); }
  });
  server.on('close', () => void service.close());
  return { server, service, async close() { await new Promise(resolve => server.close(resolve)); await service.close(); } };
}
