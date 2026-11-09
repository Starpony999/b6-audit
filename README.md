# B6 Management audits

This is the phone page for store audits and to-dos at Pizza Ranch (Wentzville and Cottleville) and Ziggi's (Wentzville and St. Peters).

The page itself is a normal website. GitHub Pages hosts it. The Google Sheet is still the database. A small Apps Script web app is only the door between the page and the sheet. People sign in with an email and a password that an admin creates. They do not sign in with Google. That is what removes the "Sorry, unable to open the file" message that showed up when someone was signed into more than one Google account.

Nothing in this repository is a password or a Backblaze key. Those stay in Apps Script → Project Settings → Script properties, or in the sheet as a scrambled password. The web app address in `js/config.js` is the front door, not a secret.

The website files live in the **root of this repo** (the same folder as this README), not in a `docs` folder. After GitHub Pages is turned on, the address is:

https://starpony999.github.io/b6-audit/

## Where each file goes

| File | Where it goes |
| --- | --- |
| `index.html` | The website. This is the page people open. |
| `css/app.css` | The website. Colors, cards, and the two-column home screen. |
| `js/config.js` | The website. The Apps Script `/exec` address is already in this file. |
| `js/api.js` | The website. Sends each action to the script. Do not put secrets here. |
| `js/app.js` | The website. Login, audits, to-dos, users, past due. |
| `js/builder.js` | The website. Template builder (admins). |
| `js/audit-ui.js` | The website. Section order, due dates, and hiding point values during an audit. |
| `js/media.js` | The website. Compresses photos and uploads them straight to Backblaze. |
| `manifest.webmanifest` | The website. Lets a phone offer "Add to Home Screen." |
| `favicon.svg` | The website. The little B6 icon. |
| `.nojekyll` | The website. Tells GitHub Pages not to ignore files. Leave it empty. |
| `.github/workflows/pages.yml` | GitHub Actions. Publishes the site when `main` changes. Do not paste this into Apps Script. |
| `apps-script/Code.gs` | **Apps Script only.** Extensions → Apps Script on the audit spreadsheet → select all of `Code.gs` → paste this whole file. |
| `apps-script/appsscript.json` | **Apps Script only.** The manifest (timezone, "run as me", "anyone"). |
| `tests/` | Stays in the repo. These are automatic checks. Do not paste them into Apps Script and do not upload them to the sheet. |
| `package.json` | Stays in the repo so `node --test` can run. There is no build step. |
| `README.md` | This file. |

You do not compile or bundle anything. The phone loads the HTML, CSS, and JavaScript files as they are.

## One-time setup

Do these in order. Skip a step only if it is already done.

### 1. Open the existing audit spreadsheet

The script has to be **bound to that spreadsheet** (Extensions → Apps Script from the sheet). A standalone script will not see the tabs.

The tabs stay named: **Users, Templates, Questions, Audits, Answers, Todos**. A **Sessions** tab is created the first time someone signs in. You do not type that one by hand.

Do not insert a new column in front of column A on any tab. Column A is the id. New columns go at the end. The "Add missing columns" button does that and does not rewrite existing cells.

### 2. Columns to add on the existing sheet

You can add these by hand **at the end of row 1**, or click **Add missing columns** in the template builder after you can sign in as an admin. Either way, existing answers, audits, and names stay put. Blank new cells mean "not set yet."

On **Users**, add:

- `passwordHash` — the scrambled password. Never type a real password into this cell.
- `salt` — random extra text mixed into the scramble so two people with the same password do not look alike.
- `passwordIterations` — how many times the scramble was repeated (the script writes `5000`).
- `mustChangePassword` — TRUE when they still need to pick their own password.
- `failedLoginCount` — wrong tries since the last good sign-in.
- `lockedUntil` — if this is a time in the future, sign-in is paused.

On **Templates**, add `appliesTo` if it is not there (ALL, RANCH, ZIGGIS, or a list like `WPR,SPZ`). Blank means all stores.

On **Questions**, add `fullPointsAnswer` if it is not there (`yes` or `no`). Blank means Yes gets full points.

On **Todos**, add these if they are not there. They stay blank until an email actually goes out:

- `assignmentNotifiedAt`
- `reminderDueSoonSentOn`
- `reminderDueDaySentOn`

`Answers.mediaUrls` and `Todos.mediaUrls` should already exist. New rows store a private file key such as `audits/…/photo.jpg`, not a Google Drive link. Old Drive links already in the sheet are left alone.

People who are already on the Users tab have no password yet. They cannot sign in until an admin sets one. The first admin can be the existing row: use that person's email in first-admin setup and the script fills the password columns on that row instead of adding a duplicate. It will not overwrite a password that is already there.

### 3. Paste the script

1. In the spreadsheet: **Extensions → Apps Script**.
2. Open `Code.gs`. Select all. Delete. Paste the entire `apps-script/Code.gs` from this repo.
3. **Project Settings →** check **Show "appsscript.json" manifest file**.
4. Open `appsscript.json`. Replace it with `apps-script/appsscript.json` from this repo.
5. In Project Settings, set the time zone to **America/Chicago**. The manifest already says that. Both should match, or due dates can slip a day.

Save.

### 4. Script properties

**Project Settings → Script properties → Add script property.** Names must match exactly. Do not put these values in GitHub, in `js/config.js`, or in the sheet.

| Property | What to put |
| --- | --- |
| `APP_URL` | `https://starpony999.github.io/b6-audit/` |
| `BOOTSTRAP_SECRET` | A long phrase only you know. You will delete this after the first admin exists. |
| `B2_KEY_ID` | Backblaze application key id (Chad). Leave blank until the bucket exists. |
| `B2_APPLICATION_KEY` | Backblaze application key (the secret). Shown once. |
| `B2_BUCKET` | Bucket name, lowercase, no spaces, no dots. Example: `b6-audit-media` |
| `B2_ENDPOINT` | Example: `s3.us-west-004.backblazeb2.com` (use the region Chad created) |
| `B2_REGION` | Example: `us-west-004` (the same region as the endpoint) |

The app runs without the five `B2_` properties. Photo and video buttons then say **Media storage is not configured.** Audits and to-dos still work.

`APP_URL` is the link in assignment and reminder emails. If it is missing, or if it is a `script.google.com` link, the email tells the person to open the B6 app and does not include the old Apps Script address.

### 5. Deploy the web app

1. **Deploy → New deployment →** type **Web app**.
2. **Execute as:** Me (the account that owns the script; later this can be `b6ranch.noreply`).
3. **Who has access:** Anyone.
4. Deploy. Authorize the sheet and the mail permission when Google asks.
5. Copy the web app URL that ends in **`/exec`**. Do not use the `/dev` URL.

Every time you change `Code.gs` after this:

**Deploy → Manage deployments → pencil → Version: New version → Deploy.**

A saved file that was not deployed is not what the phone is talking to.

### 6. Create the first admin (no default password)

1. Open the site (or a local preview) after step 7, or wait until the `/exec` URL is in `js/config.js`.
2. On the sign-in page, open **First admin setup**.
3. Enter your name, your email (the one already on the Users tab if you want to keep that row), a password of at least 10 characters, and the setup phrase.
4. Sign-in should succeed. Then in Apps Script, **delete the `BOOTSTRAP_SECRET` property**.

There is no built-in password such as `admin` or `password`. If the setup phrase is wrong eight times, setup pauses for 15 minutes. After any account has a password, this screen stops working. Use **Users → Reset password** after that.

### 7. The `/exec` URL is already in the website

`js/config.js` already points at the deployed web app:

```javascript
export const SCRIPT_URL = "https://script.google.com/macros/s/AKfycbyKHDcdkeCuG3smlzgaPTUubHIqs3S9zjqRLlXJrwTVnf5GI2r47f1-5rm19PUPseex/exec";
```

That address is the front door. It is not a Backblaze key and it is not a password. Once it is on the public site, anyone can try to sign in, and the password plus the lockout are what stop them. Do not put the setup phrase or Backblaze keys in this file. If you deploy a different web app later, replace this URL and merge that change to `main`.

### 8. Turn on GitHub Pages (once)

The workflow cannot turn Pages on by itself.

1. Open https://github.com/Starpony999/b6-audit/settings/pages
2. Under **Build and deployment**, set **Source** to **GitHub Actions**.
3. Merge this work to `main`, or re-run **Deploy to GitHub Pages** on the Actions tab.

The workflow runs the tests first. It publishes only from `main`. Pull requests do not change the live site.

To look at the page on your computer before that:

```bash
python3 -m http.server 4173
```

Open http://127.0.0.1:4173 . Sign-in still needs the deployed `/exec` URL in `js/config.js`.

### 9. Daily reminder email (once)

In the Apps Script editor, choose the function `installTodoReminderTrigger` and click **Run**. It installs a daily run around 8:15am Chicago time. Running it again is safe.

Emails send from the Google account that owns the script (MailApp), not from the person's own Gmail. `removeTodoReminderTrigger` turns them off.

### 10. Backblaze B2 (for Chad)

The bucket stays **private**. The phone never sees the application key. The script signs a short upload link (10 minutes) or view link (15 minutes). The phone talks to Backblaze directly. Only the file key is saved in the sheet.

**Application key (least privilege, one bucket):**

- Restrict the key to the single audit bucket. Not all buckets.
- Capabilities: **`readFiles`** and **`writeFiles`** only.
- Optional file-name prefix: **`audits/`** so the key cannot touch anything else in the bucket.
- Do not turn on delete files, list all bucket names, write bucket settings, share files, or "all capabilities."

**Bucket CORS** so a browser can PUT and GET from GitHub Pages. The origin has no path (`/b6-audit` is not part of it).

```json
[
  {
    "corsRuleName": "b6AuditGitHubPages",
    "allowedOrigins": [
      "https://starpony999.github.io"
    ],
    "allowedOperations": [
      "s3_put",
      "s3_get",
      "s3_head"
    ],
    "allowedHeaders": [
      "content-type",
      "x-amz-date",
      "x-amz-content-sha256",
      "authorization",
      "*"
    ],
    "exposeHeaders": [
      "etag",
      "x-amz-request-id",
      "x-amz-id-2"
    ],
    "maxAgeSeconds": 3600
  }
]
```

While testing from a computer, you may also add `http://127.0.0.1:4173` and `http://localhost:4173` to `allowedOrigins`. Remove them when you are done. Do not use `*` for origins.

Use a bucket name with only lowercase letters, numbers, and dashes. Dots in the name break the web address the phone uploads to.

## Screen addresses

Each screen has its own address after the `#`. GitHub Pages cannot route paths like `/past-due` (that would 404), so the address lives in the hash and the same `index.html` stays loaded. Refresh stays on that screen. The browser Back and Forward buttons move between screens. You can bookmark one.

| Screen | Address |
| --- | --- |
| Home | `#/home` |
| Sign in | `#/login` |
| Change password | `#/password` |
| Store picker | `#/audits` or `#/audits/CPR` (also WPR, WZ, SPZ) |
| Audit section | `#/audit/<audit id>/section/0` (0 is the first section, then 1, 2, …) |
| To-do review | `#/audit/<audit id>/review` |
| My to-dos | `#/my-todos` |
| Template builder | `#/builder` |
| Checklist editor | `#/builder/<checklist id>` |
| Users | `#/users` |
| Past due | `#/past-due` |

Fun Zone Inventory is a separate site, `https://starpony999.github.io/funzone-inventory/`. Photo and video view links are short-lived Backblaze addresses opened in a new tab. They expire, so they are not bookmarks.

The sign-in token stays in this phone's local storage until you log out or the server session hits 12 hours. Refresh and closing the tab do not log you out. On a shared phone that is the risky part: the next person is still you until someone taps Log out. Log out when you hand the phone over. (A token that vanished when the tab closed would be safer on a shared phone, and would also force a new sign-in every time the home-screen icon was opened.)

Answers, notes, and attached file names for the audit you are in are saved on the phone as you go, including the section you are on. A refresh keeps them. Photo previews may disappear after a refresh; the file is still attached if the upload finished. That saved copy is removed when the to-dos are created, or when you log out. It is not removed at "Save answers & continue", because that is the copy the phone needs for Fix answers and for refreshing the review screen. The sheet does not send those in-progress answers back.

A manager who opens `#/builder`, `#/builder/<id>`, `#/users`, or `#/past-due` sees "Only an admin can do that." The server does not send the checklist, the user list, or the past-due rows.

## How sign-in and passwords work

Apps Script cannot run bcrypt or a dedicated password service. This script uses **PBKDF2 with HMAC-SHA256, 5,000 rounds, and a random salt.** Each round scrambles the password again. Five thousand is as many as a sign-in request in Apps Script can comfortably do. A normal login server would do far more. The 15-minute lockout after 8 wrong tries is there to make guessing slow. This is an internal staff tool.

The sheet stores `salt`, `passwordHash`, and `passwordIterations`. It never stores the password. A reset shows a temporary password **once** on the admin's screen and stores only the scramble. The person must choose a new password before they can do anything else.

A sign-in returns a random session token. The sheet stores only the SHA-256 hash of that token, plus an expiry (12 hours), on the Sessions tab. Every request checks the token and then **re-reads** that person's role, active flag, and store access from Users. Changing someone from admin to manager, or unchecking Active, takes effect on their next click. Log out revokes that token.

## Who can do what

Store codes for one audit: **WPR, CPR, WZ, SPZ**.

Access codes on a person or a checklist: **ALL**, **RANCH** (WPR + CPR), **ZIGGIS** (WZ + SPZ), or a list of store codes. ALL / RANCH / ZIGGIS are not a single audit location.

Roles: **admin**, **gm**, **manager**.

- An admin can use Template builder, Past due, and Users. They can audit stores their own store access covers (an admin with ALL can do every store).
- A gm or manager can audit and complete to-dos only for stores they cover. The server rejects the template builder, Past due, and user changes even if the buttons were visible.
- To-do assignees must be active people whose access covers the audited store. Leaving a to-do unassigned is allowed. Unassigned to-dos do not send email.
- A person can update or finish their own to-do. An admin can too. Another person cannot finish someone else's to-do.
- An unassigned to-do can be updated by an admin or by someone whose access covers that store.

Point values and "which answer is full points" are not shown, and are not even sent to the phone, while the audit is in progress. The score appears on the to-do review after submit. Yes/No questions can be set so that **No** is the full-points answer. A to-do rule of **OFF** does not propose a task. A blank rule uses a default title.

New to-dos default to **30 days** out. Reminders go out **7 days before**, **the day it is due**, and **each day it is overdue**, one email per person, skipping tasks already marked done. A task that got its assignment email today does not also get a reminder the same day.

## Help testing

Do these two with a real manager (or gm) login and a real admin login. The automatic tests cover the same rules with a fake sheet. They are not a substitute for this check on the live script.

1. A non-admin cannot open the Template builder, and cannot create or edit a checklist, question, or "Add missing columns." The server refuses the request.
2. A non-admin cannot open the Past due page or load its list. The server refuses the request.

### Other checks

- Wrong email and wrong password show the same message. After 8 wrong tries, sign-in waits 15 minutes, then the right password works.
- Log out, then confirm the old session cannot load the home screen.
- Deactivate a user and confirm their next click is refused.
- Reset a password, sign in with the temporary one, and confirm the app will not leave the "new password" screen until it is changed. Confirm the temporary password is not sitting in the sheet.
- Store picker: Brian (RANCH) sees CPR checklists and can be assigned a CPR to-do. Carter (SPZ) does not, and cannot be assigned one.
- Section Next and Back keep answers, notes, and photos.
- Scores and choice point numbers are not on the audit screen.
- Save all: a bad question blocks the whole save. Add missing columns does not change names already in the sheet.
- Create to-dos, then Fix answers is locked. Submitting the same audit again before to-dos exist replaces the answer rows instead of duplicating them.
- Unassigned to-dos send no email. Two tasks for one person send one email. The link is the GitHub Pages address.
- A to-do due in 7 days, one due today, and one overdue each show up in the reminder. A done task does not. Running the reminder twice the same day does not send a second copy.
- With Backblaze properties empty, a photo shows "Media storage is not configured" and the rest of the audit still saves.
- After Backblaze is set up: a photo compresses, a video over about 8 MB is refused, the file survives Next/Back, and it shows on the to-do review. View links expire; open the app again to get a fresh one.

## What the automatic tests actually check

Run them from this folder:

```bash
node --test
```

They use a fake spreadsheet, fake mail, and a fake Apps Script `Utilities` in Node. They do **not** call Google, Gmail, or Backblaze.

They do check: password scrambling against a known PBKDF2 result, sessions stored only as a hash, lockout, logout, role and active re-read, forced password change, admin-only builder / past due / users, store and assignee filtering, scoring (including "No gets full points"), save-all refusing a bad row without writing, to-do creation, the 30-day default, reminder dates, past-due grouping, media rules, and the AWS sample signature for presigned URLs. They also check that every JavaScript file parses and that `js/config.js` points at this deployed `/exec` URL.

Not verified live: a real deploy, a real sign-in through Google's web app, a real MailApp delivery, a real Backblaze upload from a phone, or GitHub Pages itself.

## Known limits

- Each Apps Script run stops at about **6 minutes**. A normal click is much shorter. The daily reminder shares Google's trigger time cap (about 90 minutes a day on a free Gmail account, higher on Workspace).
- **MailApp** sends as the script owner. A free Gmail account is about **100 recipients a day**. A Workspace account is about **1,500**. One person getting one digest counts as one recipient. If mail fails, the to-dos are still saved. Do not click Create again.
- If the reminder sends mail and then crashes before it writes the "already sent" cell, that person can get the same reminder twice.
- The Sessions tab is the login record because Apps Script's cache can drop entries and cannot hold them longer than 6 hours. Unknown-email lockouts use that cache, so a dropped cache entry can reset the counter for an email that is not a real user. Real users are also locked on their Users row.
- Upload links last **10 minutes**. View links last **15 minutes**. The script checks type, size, and count before it signs. Backblaze does not re-check the file size on that kind of link, so the limit depends on the app refusing to ask for a link. A signed link can only name a file under that audit question.
- Removing a photo on the audit screen drops it from the audit. It does not delete the object from the bucket.
- Photos are compressed on the phone (longest side about 1600 pixels). Videos are not compressed. Over about 8 MB they are refused. Photos over about 4 MB after compression are refused.
- Password scrambling is 5,000 rounds, not the hundreds of thousands a dedicated login server would use.
- The web app is deployed as Anyone. The `/exec` URL is a front door, not a secret. Passwords protect the data.
- Keep at least one active admin. You cannot deactivate your own login.

## What changed from the old Apps Script page

The old page was drawn by Apps Script (`HtmlService`) and used the Google account that had the browser open. This repo keeps the same checklists, sections, Next/Back, to-do rules, store codes, and reminder rules, and moves the page out of Apps Script.

Also fixed while moving it: due dates are stored as a calendar day so `YYYY-MM-DD` does not land on the previous evening; a person cannot complete someone else's to-do; audits stay inside the stores that person covers; user management is admin-only because it sets passwords; scores are not included in the audit payload; the old sample functions that could write a fake user into the live sheet were removed. The home-screen Fun Zone card opens the inventory site that already exists.
