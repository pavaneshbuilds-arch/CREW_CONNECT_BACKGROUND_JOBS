# Crew Connect background jobs

Node worker that shares the Crew Connect PostgreSQL database. The API inserts a `notifications` row when something happens. This process turns due reminders into those rows, then sends each pending row through Firebase Cloud Messaging.

## What it sends

| When | Who | Type |
|---|---|---|
| Booking payment confirms | Organizer, and approved crew who can take an open role | `booking_confirmed`, `new_job_request` |
| Crew accepts a job | Organizer | `job_accepted`, and `crew_assigned` when every slot is filled |
| Crew starts a shift | Organizer | `crew_on_the_way` |
| Whole booking is completed | Organizer | `rate_experience` |
| Organizer cancels | Assigned crew | `booking_cancelled` |
| 1 day and 2 hours before the event | Organizer, and each crew member who accepted | `reminder` |
| Admin approves or rejects a crew profile or a profile edit | Crew | `profile_approved`, `profile_rejected` |
| Crew payout is processed, fails, or is reversed (once the API `payout` branch is merged) | Crew | `payout_processed`, `payout_failed`, `payout_reversed` |

Organizer pushes are skipped when `pushNotificationsEnabled` is false. The row is still stored. Crew pushes go to every active device registered with `POST /auth/devices` (`pnid` is the FCM token).

## Setup

1. Apply migrations from `CREW_CONNECT_API` (`npx prisma migrate deploy`). This worker does not own the schema.
2. Copy `.env.example` to `.env` and point `DATABASE_URL` at the same database as the API.
3. Add the Firebase service account key. This is the Admin SDK key from Firebase console → Project settings → Service accounts → Generate new private key. It is not the `google-services.json` file used in the Android build. Each push goes through the key that matches the notification's `recipient_type`. When both apps are in the same Firebase project, point both variables at the same file.

```bash
FCM_USER_SERVICE_ACCOUNT_PATH=./secrets/firebase-adminsdk.json
FCM_CREW_SERVICE_ACCOUNT_PATH=./secrets/firebase-adminsdk.json
```

You can also put one-line JSON or base64 in `FCM_USER_SERVICE_ACCOUNT_JSON` and `FCM_CREW_SERVICE_ACCOUNT_JSON`. `secrets/` is git-ignored.

4. Install and start:

```bash
npm install
npm run prisma:generate
npm start
```

In production, run it with pm2 instead of `npm start`:

```bash
npm ci
npx prisma generate
pm2 startOrReload ecosystem.config.cjs
pm2 save
pm2 logs crew-connect-jobs
```

Until an app's key is set, the worker stays up, writes reminder rows, and leaves that app's push rows `pending`. For example, with only the crew key, crew pushes go out and user pushes wait until the user key is added.

## Push payload

The FCM `notification` title and body are what the phone shows. `data` is all strings:

`notificationId`, `type`, `recipientType`, `referenceEntityType`, `referenceEntityId`, `screen`, `bookingId`, `bookingReference`, `crewId`, `payoutId`.

`screen` is `booking_details`, `job_details`, `profile`, or `earnings`.
