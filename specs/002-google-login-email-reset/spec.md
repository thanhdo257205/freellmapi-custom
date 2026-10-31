# Feature Specification: Google sign-in and email recovery

**Feature Branch**: `codex/feat-google-login-email-reset`
**Created**: 2026-11-01
**Status**: Ready for implementation
**Input**: Add Google login and forgotten-password emails delivered through Gmail.

## User Scenarios & Testing
### User Story 1 - Sign in with Google (Priority: P1)
Existing members and admins can sign in with their own Google account. New members still need an invitation.
**Independent Test**: Complete an existing-account login and an invited signup, then verify ownership and roles.
**Acceptance Scenarios**:
1. Given a verified Google identity matching an eligible existing account, completing sign-in preserves that account and role.
2. Given a new identity and valid invitation, signup creates a member and shows its initial personal key once.
3. Given no invitation, expired consent, a forged identity or a replayed callback, no account or session is granted.

### User Story 2 - Recover a forgotten password (Priority: P1)
A user enters their account email and receives a single-use link to choose a new password.
**Independent Test**: Request recovery for a member, reset its password, and verify that the admin and other members are unaffected.
**Acceptance Scenarios**:
1. Known and unknown addresses receive the same public acknowledgement.
2. A valid link changes only its owner's password and revokes their existing sessions; the user then signs in normally.
3. Expired, replayed or superseded links are rejected. Changing email or password also invalidates outstanding recovery links.

### User Story 3 - Configure integrations safely (Priority: P2)
An operator can configure Google login and one Gmail sender separately, following documented steps.
**Independent Test**: Without credentials existing password login still works; configured capabilities are exposed without secrets.
**Acceptance Scenarios**:
1. Member Google login never requests mailbox permissions.
2. Incomplete configuration does not display a working integration or leak credentials.
3. Local/desktop console recovery remains compatible; configured hosted recovery does not expose the old global console reset flow.

### Edge Cases
Consent denied, missing cookies, mismatched browser, changed email, non-authoritative Google email, exhausted invitation, delivery failure, database restart, parallel callbacks and resets, repeated email requests.

## Requirements
### Functional Requirements
- **FR-001**: Validate identity, browser binding, expiration and single use before issuing any session.
- **FR-002**: Preserve invitations, existing roles, account isolation and personal key ownership.
- **FR-003**: Never place session tokens or personal keys in redirect URLs, logs or plaintext persistent storage.
- **FR-004**: Recovery links expire after 15 minutes, are single use and target exactly one unchanged account.
- **FR-005**: Bound recovery request rates by address and source, without disclosing account existence.
- **FR-006**: Use the configured canonical website address for links; untrusted Host headers never control redirects.
- **FR-007**: Provide an accessible recovery form, Google button, cancellation feedback and one-time initial-key notice.
- **FR-008**: Include automated security, migration and frontend regression tests before merge.
### Key Entities
Google identity, browser-bound sign-in attempt, short-lived sign-in result, account-specific recovery request, rate-limit bucket.

## Success Criteria
### Measurable Outcomes
- **SC-001**: All successful authentication scenarios preserve the correct user and role.
- **SC-002**: All replay, invalid-identity and cross-account recovery scenarios are rejected by automated tests.
- **SC-003**: Users can complete recovery through the email link without operator access to logs.
- **SC-004**: Password login, existing public endpoints and all required CI checks continue to pass.

## Assumptions
The operator supplies Google credentials and authorizes a Gmail sender. These external prerequisites are currently missing; implementation and tests can proceed, but live Google consent and actual delivery require operator setup. New Google users remain invite-only. Google-authoritative verified emails may link existing accounts; other email domains require existing identity linkage and cannot claim existing accounts by email alone. No billing or paid service is required by this implementation.
