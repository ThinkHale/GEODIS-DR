# Badge Crosscheck: automated sync setup

This wires the Badge Crosscheck tool up to Power Automate so recruiters see
current discrepancies with no upload step. Manual upload still works as a
fallback the whole time, nothing about today's tool changes if you skip this.

## How it fits together

```
Beeline email  ---> Power Automate flow 1 ---\
                                               >---> Cloud Function ---> Storage (snapshots/latest.json)
CRM email      ---> Power Automate flow 2 ---/                                 |
                                                                                v
                                                              GitHub Pages tool fetches it on load
```

Two independent Power Automate flows, one per report. Each POSTs its raw
Excel file to a Cloud Function whenever its email arrives. The function saves
the file, re-reads whatever it has for the other report, and recomputes the
full reconciliation (same rules as the browser tool, same shared code) into
one JSON file. The page just fetches that file.

## Files in this delivery

- `reconcile-core.js`: the matching and recommendation logic. Used by both
  the browser tool and the Cloud Function. Don't edit this in two places,
  there's only one copy that matters (`functions/reconcile-core.js` is a
  copy for deployment, keep them identical, see note at the bottom).
- `functions/index.js`: the Cloud Function.
- `functions/package.json`: its dependencies.
- `index.html`: the updated tool. Drop this and `reconcile-core.js` into the
  same GitHub Pages folder, replacing what's there now.

## 1. Firebase project

If you don't already have one for this: [console.firebase.google.com](https://console.firebase.google.com),
create a project. Free tier (Spark plan) covers Cloud Storage; Cloud
Functions on the newer 2nd-gen runtime typically requires the pay-as-you-go
Blaze plan, but stays inside the free monthly quota for a low-volume internal
tool like this (a couple of requests a day). Worth double-checking current
Firebase pricing/plan requirements before you commit, since these change.

Enable **Cloud Storage** for the project (Build > Storage > Get started).

## 2. Storage security rules

The page needs to *read* the snapshot without logging in, but nothing should
be able to *write* to Storage except the Cloud Function (which uses trusted
Admin SDK credentials and bypasses these rules entirely). In Storage > Rules:

```
rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /snapshots/{allPaths=**} {
      allow read: if true;
      allow write: if false;
    }
    match /raw/{allPaths=**} {
      allow read: if false;
      allow write: if false;
    }
  }
}
```

This keeps the raw uploaded files (`raw/`) private, since those are the full
unfiltered exports, and only exposes the computed snapshot publicly.

## 3. Deploy the Cloud Function

Install the Firebase CLI if you don't have it (`npm install -g firebase-tools`),
then from the folder containing `functions/`:

```
firebase login
firebase init functions        # point it at your existing project, choose JavaScript
```

Copy `functions/index.js`, `functions/package.json`, and
`functions/reconcile-core.js` into the `functions/` folder it creates
(overwrite what the wizard scaffolds).

Set the shared secret (pick your own random string, this is what proves a
request actually came from your Power Automate flow):

```
firebase functions:secrets:set SYNC_KEY
```

Deploy:

```
firebase deploy --only functions:syncReport
```

The CLI prints an HTTPS URL when it finishes, something like:

```
https://us-central1-YOUR-PROJECT.cloudfunctions.net/syncReport
```

That's the endpoint Power Automate will POST to. (Exact command names and
flags can shift between Firebase CLI versions, if any of this doesn't match
what you see, the `firebase deploy` and `functions:secrets` docs will have
the current syntax.)

## 4. Point the tool at your Storage bucket

Once the function has run at least once, the snapshot lands at
`snapshots/latest.json` in your default Storage bucket. Its public URL is:

```
https://storage.googleapis.com/YOUR-PROJECT.appspot.com/snapshots/latest.json
```

Open `index.html`, find this line near the bottom of the script:

```js
const SNAPSHOT_URL = '';
```

Fill in your URL. That's the only code change needed to turn on auto-sync.

## 5. Route the report emails into their own folders

Do this part first, it needs nothing but your own Outlook and takes a few
minutes. The idea: get Outlook to pre-sort each report into its own folder
the moment it arrives, so the Power Automate trigger can just watch a folder
instead of trying to filter on sender or subject.

**Create the folders.** In Outlook, right-click your mailbox name > New
Folder. Create a parent folder, e.g. `Badge Sync`, then two subfolders
inside it: `Beeline` and `CRM`.

**Create a rule for each report.** Settings (gear icon) > Mail > Rules >
Add new rule (or Home > Rules > Manage Rules in desktop Outlook):

- Rule 1: *Condition* From contains `<the Beeline export sender address>`
  (or Subject contains `<the report's subject line pattern>`, whichever is
  more reliable). *Action* Move to `Badge Sync/Beeline`.
- Rule 2: same shape, matching the CRM export, moving to `Badge Sync/CRM`.

Pull up a recent instance of each report email to get the exact From
address and Subject text to plug in. If either report doesn't have a
consistent sender (e.g. it comes from a shared distribution address that
also sends other things), Subject is usually the safer condition to filter
on.

**Point the flow at the folder.** In each Power Automate flow, the "When a
new email arrives (V3)" trigger has a Folder field, click the folder-picker
icon next to it and choose `Badge Sync/Beeline` (or `/CRM`) instead of the
default Inbox. With the rule already doing the sorting, the trigger doesn't
need any From/Subject filter at all, only mail that belongs there ever
lands in that folder.

## 6. Power Automate flows

Build two flows, structurally identical, one per report, each watching its
own folder from step 5:

**Trigger:** "When a new email arrives (V3)" (Outlook/Office 365), Folder
set to `Badge Sync/Beeline` or `Badge Sync/CRM`.

**Get attachment content:** standard step, gives you the file as base64
already (most Outlook connectors do this natively).

**HTTP POST:**
- URL: `https://.../syncReport?type=beeline` (or `?type=crm` for the other flow)
- Headers: `x-sync-key: <the secret you set>`, `Content-Type: application/json`
- Body: `{ "fileBase64": "@{base64(triggerOutputs()?['body/attachments'][0]?['contentBytes'])}" }`
  (exact expression depends on which trigger/connector you use, this is the shape)

That's it per flow. No coordination needed between the two, the function
handles "I only have one file so far" gracefully and just waits.

## 7. Test it

1. Manually POST a Beeline file (Postman, curl, or just run the flow once
   with a real email) and check the function logs, it should report
   `computed: false, waiting on crm`.
2. POST the CRM file the same way. Now it should report `computed: true`
   with counts that match what you'd see running both files through the
   manual upload tool.
3. Open the GitHub Pages URL. It should show the synced banner immediately,
   no upload needed.
4. Click "Run a manual check instead" to confirm the fallback still works
   exactly as before.

## What's already verified vs. what needs your environment

Everything in `reconcile-core.js`, the Cloud Function's parsing and
recommendation logic, and the full browser page (both manual and synced
modes) has been tested against your actual Beeline and CRM exports and
reproduces the exact same counts either way. What hasn't been tested, since
it needs a live Firebase project and Power Automate environment: the actual
deployment, the security rules, the Outlook rules, and the Power Automate
HTTP call syntax for your specific connector. Those are worth a real test
run before you trust it for daily use.

## Keeping the two copies of reconcile-core.js in sync

`reconcile-core.js` lives in two places in this delivery, one next to
`index.html` for the browser, one inside `functions/` for the Cloud
Function (Cloud Functions can't reach outside their own folder at deploy
time). If you ever change the matching or recommendation rules, change both
copies, or better, set up your GitHub Pages repo and your Functions repo to
both pull from one shared file (a git submodule, or just a small script that
copies it into place before each deploy).
