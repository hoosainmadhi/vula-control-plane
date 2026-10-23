# Control Plane Releases UI

The Releases workspace builds on the existing Control Plane APIs and components.

## Delivered

- Fleet overview for Stores and Head Offices with environment, current/desired
  version, digest, channel, deploy state and release state.
- Search and kind filters, health/attention summary.
- Release catalog with immutable digest, version, revision, channel and schema
  range.
- Publish-release form requiring the tag to be typed before submission.
- Per-tenant Upgrade and Rollback dialogs with typed tenant-slug confirmation.
- Rollout dialog with release, tenant selection, wave size, dry run and
  stop-on-failure; batch table and item detail with errors.
- Per-tenant release history, including failed attempts and error text.
- Release-manager controls are disabled for non-managers and enforced again by
  the server through `requireReleaseManager`.

## Authorization

`GET /api/releases/capabilities` drives the read-only state in the UI. Every
release mutation route requires an office session plus an email in
`RELEASE_MANAGER_EMAILS`; production with an empty allowlist denies mutations.
Existing failed history is never rewritten by the UI.

## Validation

- Frontend production build: passing.
- Frontend UI suite: 33/33.
- Full CP backend suite: 532/532, 42 suites; typecheck and build clean.
- Live staging check: fleet, catalog, rollouts and history rendered; staging
  release-manager actions available; CP healthy.
