# GEODIS Management Suite data model

The browser currently stores this schema in a versioned, user-scoped local envelope. It is deliberately shaped so the same records can move to an authenticated cloud store without changing the attendance workflow.

## Local envelope

```text
geodisSuite.userData.v2
  schemaVersion: 2
  updatedAt: ISO timestamp
  users
    {uid}
      associates[]
      attendance[]
      attendanceSessions[]
      timeOff[]
      requisitions[]
```

Every browser receives a stable local user ID. Existing `geodisSuite.v1` data is migrated into that user's v2 record on first load.

## Cloud-ready document layout

When authentication and a database region are approved, use the following ownership boundary:

```text
users/{uid}
users/{uid}/preferences/{document}
users/{uid}/attendanceSessions/{sessionId}
users/{uid}/attendanceSessions/{sessionId}/results/{resultId}
users/{uid}/attendanceEvents/{eventId}
users/{uid}/timeOff/{requestId}
users/{uid}/requisitions/{requisitionId}
users/{uid}/associates/{associateId}
```

All reads and writes must require an authenticated user and match `request.auth.uid` to the `{uid}` path segment. Shared location-level reporting should be added later through explicit membership and role documents rather than weakening per-user ownership.

## Attendance session

An attendance reconciliation session contains:

- `ownerId`, `date`, `shift`, `createdAt`, and `updatedAt`
- `timeclockFile` and normalized `timeclockRows`
- original `clientPaste` and normalized `clientRows`
- reconciled results with badge, name, match state, clock time, and exception reason

Match states are `matched`, `client-only`, and `clock-only`. Badge is authoritative when present; normalized full name is the fallback.

## Deployment decision still required

The Firebase project currently has no Firestore database. Before provisioning, select the database region. The existing Cloud Function runs in `us-central1`, so colocating there is the simplest latency and operations choice if it meets organizational requirements.
