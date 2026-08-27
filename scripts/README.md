# Pushing the PLX workbook without GEODIS tenant access

The workbook lives on `geodis.sharepoint.com`. Power Automate runs in the
**Employbridge** tenant. A connector there cannot obtain a token SharePoint will
accept for another tenant's site — that is the `Invalid audience Uri` 401, and
reauthorising the connection does not help because nothing is wrong with it.

Guest access lets you **open and sync** the file, though. It just does not let a
service in another tenant get a token for it. So this reads the synced copy from
your own Mac and posts it, and never crosses a tenant boundary.

## Setup, once

**1. Sync the library.** Open the folder in the browser:

`…/sites/chicago-campus-operations/Shared Documents/1519/Lego Main Office/Lego Agencies Tracker/`

and choose **Sync** (or *Add shortcut to OneDrive*). It appears under
`~/Library/CloudStorage/`. Open the workbook once so OneDrive downloads the
contents rather than leaving a placeholder.

**2. Store the sync key in the Keychain** — never in a file:

```sh
security add-generic-password -a "$USER" -s geodis-sync-key -w
```

It prompts for the value. Paste the same key the report flow uses.

**3. Try it by hand:**

```sh
./scripts/push-plx.sh
```

A good run logs `OK shiftTags=314 sites=7 openOrders=20`. Everything is written
to `~/Library/Logs/geodis-plx-push.log`.

## Schedule it for 8am and 4pm

```sh
sed "s|REPLACE_WITH_FULL_PATH|$PWD|" scripts/com.thinkhale.geodis.plx.plist \
  > ~/Library/LaunchAgents/com.thinkhale.geodis.plx.plist
launchctl load ~/Library/LaunchAgents/com.thinkhale.geodis.plx.plist
```

To stop it: `launchctl unload ~/Library/LaunchAgents/com.thinkhale.geodis.plx.plist`

`launchd` uses the machine's timezone, so 8am stays 8am through daylight saving —
unlike a UTC cloud schedule, which drifts by an hour twice a year.

## What it refuses to do

- **No file** → says the library is not synced, rather than posting nothing.
- **A OneDrive placeholder** (under 20KB) → refuses, because posting a stub would
  look like a successful sync that produced no shift tags.
- **No Keychain entry** → stops before posting, so a run never half-succeeds.

## The catch

It only runs when the Mac is awake and online. If that is not good enough, the
durable fix is to get the file into your own tenant — ask a GEODIS colleague to
mail it on a schedule, or copy it into your Employbridge OneDrive — and read it
there with a normal Power Automate flow. This is the version that needs nobody
else.
