// scripts/check-groceries-syntax.js — verifies routes/groceries.js loads and registers all four routes
const router = require('../routes/groceries');

const routes = [];
for (const layer of router.stack) {
  if (layer.route) {
    const methods = Object.keys(layer.route.methods).join(',').toUpperCase();
    routes.push(`${methods} ${layer.route.path}`);
  }
}
console.log('Registered routes:');
routes.forEach((r) => console.log('  ' + r));

const expected = [
  'POST /shopping-trips',
  'GET /food-items',
  'PATCH /food-items/:id/consume',
  'PUT /food-items/:id'
];
const missing = expected.filter((e) => !routes.includes(e));
if (missing.length) {
  console.error('MISSING routes: ' + missing.join(' | '));
  process.exit(1);
}
console.log('OK — all four grocery routes registered.');