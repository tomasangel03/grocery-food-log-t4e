// One-shot diagnostic: require each server module and report the first failure.
'use strict';
const mods = ['dotenv', 'express', 'mysql2', 'bcrypt', 'jsonwebtoken', 'node-cron', 'uuid', 'google-auth-library'];
for (const m of mods) {
  try {
    require(m);
    console.log('OK dep:', m);
  } catch (e) {
    console.error('FAIL dep:', m, '-', e.message);
  }
}
const local = ['../db', '../middleware/auth', '../routes/auth', '../routes/groceries', '../routes/dashboard', '../routes/admin', '../jobs/monthlyStats'];
for (const m of local) {
  try {
    require(m);
    console.log('OK module:', m);
  } catch (e) {
    console.error('FAIL module:', m, '-', e.message);
    console.error(e.stack.split('\n').slice(0, 5).join('\n'));
  }
}
console.log('DIAG DONE');