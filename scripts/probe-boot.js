// One-shot boot probe: hits the running server and reports status codes.
const http = require('http');

const PORT = process.argv[2] || 45059;

function get(path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path, timeout: 5000 }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ path, status: res.statusCode, snippet: body.slice(0, 120).replace(/\s+/g, ' ') }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout ' + path)); });
  });
}

(async () => {
  try {
    const results = [];
    results.push(await get('/login.html'));
    results.push(await get('/api/auth/login')); // GET on POST route — expect 404/405, proves router mounted
    for (const r of results) console.log(`${r.path} -> ${r.status} | ${r.snippet}`);
    console.log('PROBE OK');
    process.exit(0);
  } catch (e) {
    console.error('PROBE FAILED:', e.message);
    process.exit(1);
  }
})();