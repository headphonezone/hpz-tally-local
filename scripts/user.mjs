// Manage the app's logins (data/users.json).
//   node scripts/user.mjs add <name>      make an account and print a one-time password
//   node scripts/user.mjs reset <name>    new one-time password for an existing account
//   node scripts/user.mjs remove <name>   delete an account (signs that person out)
//   node scripts/user.mjs list
import { randomBytes } from 'node:crypto';
import { loadUsers, setPassword, removeUser, validName } from '../lib/auth.mjs';

const [cmd, name] = process.argv.slice(2);
const newPassword = () => randomBytes(9).toString('base64url');   // 12 characters, shown once

try {
  if (cmd === 'list') {
    const u = loadUsers(); const names = Object.keys(u);
    console.log(names.length ? names.map((n) => `${n.padEnd(20)} created ${u[n].created?.slice(0, 10)}  password changed ${u[n].changed?.slice(0, 10)}`).join('\n') : 'no accounts yet');
  } else if (cmd === 'add' || cmd === 'reset') {
    if (!validName(name)) throw new Error('give a name: 2-32 characters, lower case letters, digits, . _ -');
    const exists = Boolean(loadUsers()[name]);
    if (cmd === 'add' && exists) throw new Error(`"${name}" already exists (use reset to give a new password)`);
    if (cmd === 'reset' && !exists) throw new Error(`no account "${name}" (use add)`);
    const pw = newPassword(); setPassword(name, pw);
    console.log(`${cmd === 'add' ? 'Created' : 'New password for'} ${name}\n  password: ${pw}\n(shown once — give it to ${name}; they sign in at the app's address)`);
  } else if (cmd === 'remove') {
    console.log(removeUser(name) ? `Removed ${name}` : `no account "${name}"`);
  } else {
    console.log('usage: node scripts/user.mjs add|reset|remove <name>  |  list');
    process.exitCode = 1;
  }
} catch (err) { console.error(err.message); process.exitCode = 1; }
