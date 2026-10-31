# Feature Specification: Optional Turso database

**Created**: 2026-10-31
**Status**: Accepted for implementation
**Input**: Try Turso using the existing CLI/account, without affecting another project.

## User Scenarios & Testing

### User Story 1 - Preserve hosted data (Priority: P1)

The operator selects a dedicated hosted database so accounts, invitations, provider credentials and settings survive replacement of the application host.

**Independent Test**: Create an account and setting, close the application, reconnect with no local data, and verify both persist.

**Acceptance Scenarios**:
1. Given a dedicated empty hosted database, when the app starts, then initialization completes and account setup is available.
2. Given saved data, when the application restarts, then account login and saved settings still work.
3. Given invalid credentials, when the application starts, then it fails clearly without exposing credentials or silently creating a local database.

### User Story 2 - Keep existing installations working (Priority: P1)

Existing local and Docker installations retain their current behavior unless the operator explicitly selects hosted storage.

**Independent Test**: Run migrations and account operations with no hosted configuration.

**Acceptance Scenarios**:
1. Given no hosted configuration, when the app starts, then existing local storage is used unchanged.
2. Given hosted configuration, when a file-only backup is requested, then the app does not present a local file as a backup of the hosted data.

### User Story 3 - Evaluate safely (Priority: P2)

The operator can evaluate the integration in an isolated database and follow documented deployment and data transfer steps.

**Independent Test**: Follow the deployment guide against a new database without altering the other project's database.

**Acceptance Scenarios**:
1. Given another project on the same account, when this trial runs, then that project's database is untouched.
2. Given an existing deployment, when preparing a move, then instructions require a consistent export and preservation of its encryption key.

### Edge Cases

- Missing token, malformed URL, unavailable service or incompatible engine.
- Nested transactions, migration rollback and multi-statement initialization.
- Accidental mixture of hosted storage and file backup settings.
- Network latency during synchronous requests and trial suitability for real traffic.

## Requirements

### Functional Requirements

- **FR-001**: Hosted storage MUST be opt-in and use a dedicated database.
- **FR-002**: Existing accounts, sessions, invitations and settings MUST survive a host restart.
- **FR-003**: Existing local deployments and public endpoints MUST remain compatible.
- **FR-004**: Credentials MUST never appear in logs, committed files or responses.
- **FR-005**: An explicit encryption key MUST be required for hosted storage in every environment.
- **FR-006**: Failed transactions MUST roll back, including nested transaction boundaries.
- **FR-007**: File-only backup mechanisms MUST NOT read or overwrite unrelated local files in hosted mode.
- **FR-008**: Automated tests MUST cover initialization, transaction behavior and local compatibility.
- **FR-009**: Production data transfer and Render cutover remain separate from the isolated trial.

### Key Entities

- Database configuration: selected backend and its connection credentials.
- Application data: existing schema; no new business entities.
- Trial database: separate from the operator's existing projects.

## Success Criteria

### Measurable Outcomes

- **SC-001**: Account and setting persistence passes after closing and reopening a connection.
- **SC-002**: Every failed transaction in the test scenarios leaves zero partial writes.
- **SC-003**: Existing local migration tests continue to pass.
- **SC-004**: No other project's data is changed during the trial.

## Assumptions

- The operator authorizes a separate free trial database under their existing account.
- This first integration targets one application instance and modest trial traffic.
- The current Render service and its data are not cut over automatically.
