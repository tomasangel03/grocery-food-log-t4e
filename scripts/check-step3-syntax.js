// One-shot syntax check for step 3 edits
const { execFileSync } = require('child_process');
const files = ['routes/groceries.js', 'public/js/shell.js'];
for (const f of files) {
  execFileSync(process.execPath, ['--check', f], { stdio: 'inherit' });
  console.log('OK  ' + f);
}
console.log('All syntax checks passed');