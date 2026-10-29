# Running the app on a shared server PC

One copy of the app runs on one PC (the **server PC**). Everyone else opens it in the browser at that PC's
address and signs in with their own name. Tally data is already shared through the Tally Server, so the only
thing that needs one home is the app's own history (Stock Journal / Sales / Credit Note History, the
"last number used" record), and that is exactly what lives on the server PC.

Up to 5 people at once. Tally takes one job at a time, so while one person's fetch or posting is running the
others see "<name> is running a Tally job right now" and wait a few seconds. Each person has their own fetched
lists (Sales, Credit Notes, COD ...), so two people can work on different date ranges without disturbing each other.

## What the server PC needs

- **Tally Prime open all day** with the Headphone Zone company loaded, connected to the Tally Server, and its
  gateway enabled on port 9000. The app reads and writes Tally through it.
- **Node.js 22 or newer** (the app uses its built-in SQLite). `node --version` to check.
- **16 GB of RAM or more** (the HPZ server PC has 32 GB): a month of Unicommerce orders is about 400 MB in memory, per person. The pm2 settings allow the app up to 6 GB before it restarts itself.
- A **fixed address**: give the PC a reserved IP on the router (or use its computer name) so the link does not change.

## One-time setup

1. Get the code: `git clone https://github.com/headphonezone/hpz-tally-local.git`, then in that folder `npm install`.
2. Copy **`.env`** from the current PC (it holds the Tally, Unicommerce and RMS settings and secrets — copy it
   by USB or a private share, never by email or GitHub). Add this line to it:

       HPZ_HOST=0.0.0.0

   Keep `HPZ_TALLY_URL=http://localhost:9000` — Tally runs on this same PC.
3. Copy the **`data`** folder from the current PC into the app folder, if you want the existing history to
   carry over. Do this with the app stopped. Rows made before accounts existed show an empty "By" column.
4. Make the logins, one per person (5 at most is the plan, there is no hard limit):

       node scripts/user.mjs add priya
       node scripts/user.mjs add ravi

   Each prints a one-time password. Give it to that person. `node scripts/user.mjs reset <name>` gives a
   new one, `remove <name>` deletes the account, `list` shows who exists.
5. Let other PCs in through the Windows firewall (run once, as administrator, on the server PC):

       netsh advfirewall firewall add rule name="HPZ Tally App" dir=in action=allow protocol=TCP localport=7654 profile=private

6. Start it, and keep it running:

       npm install -g pm2
       pm2 start ecosystem.config.cjs
       pm2 save

   To have it start when Windows starts, add a Task Scheduler task "At log on" that runs `pm2 resurrect`
   (or use the pm2-windows-startup package).

7. On each other PC open `http://<server-pc-address>:7654` and sign in. Make a Desktop shortcut to that address.

The app refuses to start with `HPZ_HOST=0.0.0.0` until at least one account exists, so it can never be
exposed without a login.

## Updating the app later

On the build PC: commit, push to GitHub, merge. On the server PC:

    git pull
    npm install        # only if package.json changed
    pm2 restart hpz-materialout

Check nobody is in the middle of a posting first: the screen shows a banner when someone is running a job.
Signed-in sessions survive a restart (12 hours, renewed while in use). Fetched lists do not: people press Fetch again.

## Things to know

- **Do not also run the app on another PC for real work.** That copy would have its own separate history.
  Use the build PC only for building and testing.
- **The login travels over plain HTTP on the office network.** That is fine on a private office LAN. Do not
  open port 7654 to the internet, and do not forward it on the router.
- Five wrong passwords for a name from one PC locks that name on that PC for a minute.
- Passwords are stored hashed (scrypt) in `data/users.json`; sessions in `data/sessions.json`. Both are in the
  `data` folder, which is never in GitHub.
- Back up the `data` folder regularly: it is the app's only record of what it posted and who posted it.

## The daily dispatch mail

The app sends the 09:00 e-Way Bill / e-Invoice report itself (set `DISPATCH_MAIL=on` in `.env`, with the `SMTP_*` and `MAIL_TO` settings). It covers the
invoices of **yesterday only** (`DISPATCH_MAIL_DAYS` asks for more), says for e-Way Bills and e-Invoices how many were created, closed and not closed and lists
them, checks the e-Way Bills against the GSP portal once (1 paid call a day), closes what BlueDart has dispatched first, and mails the PDF. **Tally does not need to be open at 09:00**: the app keeps its last read of Tally (every 15 minutes while Tally is open, in
`data/tally-gst-snapshot.json`) and the report says "Tally was not open ... data as last read on ...", so Tally must have been open at some point in the
previous 3 days. If the report cannot be built at all (GSP or mail server down, no recent Tally read) it tries again every 10 minutes, three times, then mails a
"NOT SENT" notice. **Turn off the old Task Scheduler job `TallyDispatchEmail` (dispatch_email.py) when you turn this on**, or two mails go out each morning.
To try it without sending: `POST /api/gst/mail-run` with `{}` writes a preview and PDF to `data/` (`{"offline":true}` tries the Tally-closed path).
