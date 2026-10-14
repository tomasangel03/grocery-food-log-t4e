// Starts a local PostgreSQL when Docker is not installed.
// The binaries come from the embedded-postgres dev dependency.
// Leave this process running while you use the app. It stops Postgres on exit.
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binDir = path.join(root, 'node_modules', '@embedded-postgres', 'windows-x64', 'native', 'bin');
const dataDir = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'foodlog-pg');
const port = 5432;
const user = 'foodlog';
const password = 'foodlog';

function splitSql(sql) {
  const statements = [];
  let current = '';
  let i = 0;
  let dollar = null;
  while (i < sql.length) {
    if (!dollar && sql.startsWith('--', i)) {
      const nl = sql.indexOf('\n', i);
      i = nl === -1 ? sql.length : nl + 1;
      continue;
    }
    if (!dollar && sql[i] === "'") {
      current += sql[i];
      i += 1;
      while (i < sql.length) {
        current += sql[i];
        if (sql[i] === "'" && sql[i + 1] === "'") {
          current += sql[i + 1];
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    if (!dollar && sql[i] === '$') {
      const match = sql.slice(i).match(/^\$[A-Za-z0-9_]*\$/);
      if (match) {
        dollar = match[0];
        current += match[0];
        i += match[0].length;
        continue;
      }
    }
    if (dollar && sql.startsWith(dollar, i)) {
      current += dollar;
      i += dollar.length;
      dollar = null;
      continue;
    }
    if (!dollar && sql[i] === ';') {
      const statement = current.trim();
      if (statement) statements.push(statement);
      current = '';
      i += 1;
      continue;
    }
    current += sql[i];
    i += 1;
  }
  const tail = current.trim();
  if (tail) statements.push(tail);
  return statements;
}

function run(exe, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(exe)} exited with code ${code}`));
    });
  });
}

function waitUntilReady(child) {
  return new Promise((resolve, reject) => {
    let log = '';
    const onData = (chunk) => {
      const text = chunk.toString();
      process.stderr.write(text);
      log += text;
      if (log.includes('database system is ready to accept connections')) resolve();
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', reject);
    child.on('exit', (code) => {
      reject(new Error(`Postgres exited before it was ready (code ${code}).\n${log}`));
    });
  });
}

async function main() {
  const initdb = path.join(binDir, 'initdb.exe');
  const postgres = path.join(binDir, 'postgres.exe');
  if (!fs.existsSync(postgres)) {
    throw new Error('Postgres binaries are missing. Run: npm install --strict-ssl=false');
  }

  if (!fs.existsSync(path.join(dataDir, 'PG_VERSION'))) {
    fs.mkdirSync(dataDir, { recursive: true });
    const pwFile = path.join(os.tmpdir(), `foodlog-pw-${process.pid}.txt`);
    fs.writeFileSync(pwFile, `${password}\n`);
    try {
      await run(initdb, [
        `--pgdata=${dataDir}`,
        '--auth=scram-sha-256',
        `--username=${user}`,
        `--pwfile=${pwFile}`,
        '--encoding=UTF8',
        '--locale=C'
      ]);
    } finally {
      fs.rmSync(pwFile, { force: true });
    }
  }

  const server = spawn(postgres, ['-D', dataDir, '-p', String(port)], {
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const shutdown = () => {
    if (server.pid) spawn('taskkill', ['/pid', String(server.pid), '/f', '/t']);
  };
  process.on('SIGINT', () => { shutdown(); process.exit(0); });
  process.on('SIGTERM', () => { shutdown(); process.exit(0); });
  process.on('exit', shutdown);

  await waitUntilReady(server);

  const admin = new pg.Client({ host: '127.0.0.1', port, user, password, database: 'postgres' });
  await admin.connect();
  const existing = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', ['foodlog']);
  if (existing.rowCount === 0) {
    await admin.query('CREATE DATABASE foodlog');
  }
  await admin.end();

  const db = new pg.Client({ host: '127.0.0.1', port, user, password, database: 'foodlog' });
  await db.connect();
  const migDir = path.join(root, 'migrations');
  const files = fs.readdirSync(migDir).filter((name) => name.endsWith('.sql')).sort();
  for (const file of files) {
    const sql = fs.readFileSync(path.join(migDir, file), 'utf8');
    for (const statement of splitSql(sql)) {
      await db.query(statement);
    }
  }
  await db.end();

  console.log(`Local Postgres is ready at postgres://${user}:${password}@127.0.0.1:${port}/foodlog`);
  console.log(`Data directory: ${dataDir}`);
  console.log('Leave this process running, then run: npm run seed && npm start');
  await new Promise(() => {});
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
