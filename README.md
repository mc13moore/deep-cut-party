# Deep Cut: Birthday Party Edition

The game plus a live team scoreboard. Every player's score is sent to the scoreboard automatically, for test runs and the real round. Guests just open the link. They don't need an account.

## What you need
- A free Cloudflare account: https://dash.cloudflare.com/sign-up
- Node.js 18 or newer: https://nodejs.org (check with `node -v`)

## Deploy (about 10 minutes)

Unzip this folder, open a terminal in it, and run:

**1. Log in to Cloudflare** (opens your browser)
```
npx wrangler login
```

**2. Create the score database**
```
npx wrangler d1 create deep-cut-party
```
It prints a `database_id`. Open `wrangler.toml` and paste that id in place of `PASTE-DATABASE-ID-HERE`.

**3. Set your host PIN**
In `wrangler.toml`, change `HOST_PIN = "1234"` to your own PIN. It unlocks the scoreboard's host controls.

**4. Create the site and deploy**
```
npx wrangler pages project create deep-cut-party --production-branch main
npx wrangler pages deploy
```
At the end it prints your link, something like `https://deep-cut-party.pages.dev`. Send that to the group.

(The tables are created by themselves on first use. There's nothing else to set up.)

## On the day
- **Scoreboard:** open `https://<your-link>/#scoreboard` on a TV or laptop. It updates every few seconds as people finish.
- **Host controls:** on the scoreboard, enter your PIN to fix or remove entries, add a score by hand, rename teams, or reset.
- **Test runs:** on the home screen, tap **🧪 Test run** and pick Run 1–3. Scores go to the **Test** tab of the scoreboard, and test runs never use the real party prompts. Clear the test board when you're done, then switch the scoreboard back to **Live party**.
- **Real round:** guests tap **🎂 Birthday party round**. They get one try per name per phone, and their score posts to the Live board when they finish.
- **Someone opened the real round by accident while testing?** On that phone, open `https://<your-link>/#unlock-party`.
- **If a phone has no signal when it finishes,** the card shows **Try again**. It also re-sends by itself the next time the page opens.

## Changing things later
Edit `public/index.html` (prompts are in `BANK` near the top), then run `npx wrangler pages deploy` again.
