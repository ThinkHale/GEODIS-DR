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

## Automating the Beeline requisition exports

The two Beeline exports land by email each morning:

| Report | Carries |
| --- | --- |
| **GEODIS Open Reqs** | openings, the submitted/declined/offered/hired pipeline, hiring manager, profit centre (which is where the market comes from) |
| **Candidate Status per Req** | who is attached to each req, their Beeline id, job position, work location |

Neither is complete on its own, and both list **one row per (req × candidate)** —
633 rows is 110 requests, not 633.

One flow handles both. Move both reports into a single Outlook folder, point the
flow at that folder, and it posts every attachment that lands there to
`?reqSync=1`. **Which report a file is, is worked out from its columns**, not
from the file name or the subject line — so the two can share a folder, the
export can be renamed, and neither can be filed as the other.

### 1. One Outlook folder, two rules

Right-click the mailbox → **New Folder**, e.g. `Beeline Reqs`. Then
Settings → Mail → **Rules** → Add new rule, once per report:

- *Condition:* Subject contains `<the report's subject text>` — Subject is
  usually safer than From, since both reports come from the same Beeline sender.
- *Action:* Move to `Beeline Reqs`, and tick **Stop processing more rules**.

Pull up a recent copy of each email to get the exact subject text. Both rules
target the **same** folder.

### 2. The flow

**Trigger:** *When a new email arrives (V3)* — Folder: `Beeline Reqs`,
**Only with attachments: Yes**, Include Attachments: **Yes**.

**Action:** *Apply to each* over `triggerOutputs()?['body/attachments']`, with one
**HTTP** action inside it. Looping matters: if a morning's mail ever carries both
reports on one message, both get posted.

- Method: `POST`
- URI: `https://syncreport-eusvh7xq5q-uc.a.run.app/?reqSync=1`
- Headers: `x-sync-key: <the SYNC_KEY secret>`, `Content-Type: application/json`
- Body:

```json
{
  "fileBase64": "@{items('Apply_to_each')?['contentBytes']}",
  "fileName":   "@{items('Apply_to_each')?['name']}"
}
```

`contentBytes` comes back in whichever shape your connector produces — raw
base64, base64-of-base64, or a `{"$content-type":…,"$content":…}` envelope. The
endpoint takes all three, so there is nothing to get right here.

### 3. What it does with each file

1. Refuses anything without a `Request-ID` column, **without touching what is
   already stored** — a rule that fires on the wrong email cannot wipe a
   working report.
2. Saves the raw file under whichever half it turned out to be.
3. Rebuilds the board from **every** stored half and writes the `requisitions`
   and `reqCandidates` collections.

Step 3 is why nothing waits for the second email. The 06:00 reqs export
publishes immediately; the 06:05 candidate export adds to it. Without it, the
first email of the day would publish a board with no candidates on it and wipe
the list the previous morning left.

Requests **typed into the suite by hand are left alone**, and a req that has left
Beeline keeps its record with only its Beeline half cleared — the workbook or a
person may be the only thing that knows about it.

### 4. Check it

Beeline Requests shows a bar naming each half, when it last arrived, and how many
rows it carried. The halves are aged **separately** on purpose: the failure that
actually happens is one Outlook rule breaking while the other keeps working,
which otherwise looks like a perfectly current board carrying last week's
candidates. Past 30 hours — a missed morning — that half goes loud.

To test without waiting for tomorrow's email, POST a saved copy of either report
to the endpoint directly (see the curl below). That proves the function, the key
and the parsing independently of whether the Outlook trigger fired — which is the
split you want when something is not working, because they fail for different
reasons and the flow run history only tells you about the second one.

```sh
# base64 the file, post it, and read back what the endpoint made of it
python3 -c "import base64,json,sys;print(json.dumps({'fileBase64':base64.b64encode(open(sys.argv[1],'rb').read()).decode(),'fileName':sys.argv[1]}))" \
  "GEODIS Open Reqs.xlsx" > /tmp/req.json
curl -s -X POST "https://syncreport-eusvh7xq5q-uc.a.run.app/?reqSync=1" \
  -H "x-sync-key: $SYNC_KEY" -H 'Content-Type: application/json' \
  --data @/tmp/req.json | python3 -m json.tool
```

The manual **Add an export by hand** panel stays exactly as it is, for a report
that did not arrive or an off-cycle pull.

## What's already verified vs. what needs your environment

Everything in `reconcile-core.js`, the Cloud Function's parsing and
recommendation logic, and the full browser page (both manual and synced
modes) has been tested against your actual Beeline and CRM exports and
reproduces the exact same counts either way. What hasn't been tested, since
it needs a live Firebase project and Power Automate environment: the actual
deployment, the security rules, the Outlook rules, and the Power Automate
HTTP call syntax for your specific connector. Those are worth a real test
run before you trust it for daily use.

## Keeping the shared core files in sync

Several core files live in two places, one at the repo root for the browser and
one inside `functions/` for the Cloud Function (Cloud Functions can't reach
outside their own folder at deploy time): `reconcile-core.js`, `reqs-core.js`,
`schedule-core.js`, `shift-key.js`, `timeoff-core.js`, `tasks-core.js`,
`contacts-core.js`, `pipeline-core.js`, `payroll-core.js`, `auth-core.js`.

If you change one, change both copies. To check them all at once:

```sh
for f in reconcile-core reqs-core schedule-core shift-key timeoff-core \
         tasks-core contacts-core pipeline-core payroll-core auth-core; do
  diff -q "$f.js" "functions/$f.js" || echo "DRIFTED: $f.js"
done
```

`shift-key.js` had already drifted once this way — the browser copy gained the
connection-review logic and the deployed copy did not. Nothing broke, because
the function does not call it, which is exactly what makes this the kind of
drift you find late.
