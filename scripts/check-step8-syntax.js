// scripts/check-step8-syntax.js — load-check the step-8 modules and list their routes
const dashboard = require('../routes/dashboard');
const admin = require('../routes/admin');
const monthly = require('../jobs/monthlyStats');

function routesOf(router) {
  return router.stack
    .filter((l) => l.route)
    .map((l) => `${Object.keys(l.route.methods).join(',').toUpperCase()} ${l.route.path}`);
}

console.log('dashboard routes:', routesOf(dashboard));
console.log('admin routes:', routesOf(admin));
console.log('monthlyStats exports:', Object.keys(monthly));

// Also verify server.js parses (without listening) via require cache trick is risky;
// instead just syntax-check it:
const { execSync } = require('child_process');
execSync('node --check server.js', { cwd: __dirname + '/..', stdio: 'inherit' });
console.log('server.js syntax OK');
process.exit(0);