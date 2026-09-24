'use strict';

// Create the panel admin. Run ON THE SERVER, once:
//   node scripts/create-admin.js
// Hidden password prompt, min 12 chars, refuses if any user exists.
// The password never touches env, argv, HTTP, or disk outside users.json (0600).
const readline = require('readline');
const store = require('../lib/store');

async function readPipeLines() {
  // A second rl.question() on an already-ended pipe never fires, so for
  // non-TTY stdin (pack.js, tests) read all lines upfront instead.
  let data = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) data += chunk;
  return data.split(/\r?\n/);
}

async function main() {
  if (store.loadUsers().length > 0) {
    console.error('refusing: a user already exists');
    process.exit(1);
  }
  const username = (process.argv[2] || 'admin').slice(0, 64);
  const tty = !!process.stdin.isTTY;
  let password;
  let confirm;
  if (!tty) {
    const lines = await readPipeLines();
    password = (lines[0] || '').trim();
    confirm = (lines[1] || '').trim();
  } else {
    // Interactive TTY: single readline interface with hidden echo.
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const state = { muted: false };
    const orig = rl._writeToOutput.bind(rl);
    rl._writeToOutput = (s) => {
      if (!state.muted) return orig(s);
      if (s === '\r\n' || s === '\n' || s === '\r') return orig(s);
      return undefined; // swallow typed characters (no echo)
    };
    const ask = (question) => new Promise((resolve) => {
      rl.question(question, (answer) => {
        state.muted = false;
        process.stdout.write('\n');
        resolve(String(answer).replace(/[\r\n]+$/, ''));
      });
      state.muted = true; // mute typed input only, never the prompt
    });
    password = await ask('New admin password (min 12 chars): ');
    confirm = await ask('Repeat password: ');
    rl.close();
  }
  if (!password || password.length < 12) {
    console.error('password too short');
    process.exit(1);
  }
  if (confirm !== password) {
    console.error('passwords do not match');
    process.exit(1);
  }
  const user = store.createUser(username, password);
  console.log(`created admin: ${user.username}`);
}

if (require.main === module) {
  main().catch((err) => { console.error(err.message); process.exit(1); });
}
