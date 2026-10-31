# FreeLLMAPI Project Constitution

## Core Principles

### I. Security & Credential Protection (NON-NEGOTIABLE)
- Provider API keys and sensitive tokens must ALWAYS be encrypted at rest using AES-GCM with `ENCRYPTION_KEY`.
- Log redaction is mandatory: zero provider keys, auth tokens, or credentials may ever reach stdout/stderr or logs.
- Never defeat access controls, auth middleware, or trust-proxy guardrails.

### II. Monorepo Architecture & Separation of Concerns
- The project is structured as an npm monorepo (`shared`, `server`, `client`, `cli`, `desktop`).
- Shared schemas, types, and DTOs belong in `@freellmapi/shared`.
- The Express routing engine resides in `server/`, React UI in `client/`, and command-line tools in `cli/`.
- Cross-package dependencies must be explicit and avoid circular references.

### III. Robustness & Upstream Resilience
- Resilient outbound proxy dispatching: handle provider connection resets, rate limits, and fallback chains gracefully.
- Maintain idempotent database migrations and declarative configuration support (`FREEAPI_CONFIG_JSON`).
- Support containerization constraints (non-root Docker runtime, volume permission handling, healthchecks).

### IV. Test-First & Quality Verification
- All new features and bug fixes must include unit or integration tests via Vitest / Node test runner.
- Changes must pass `npm run test` and `npm run lint` before merging.
- Database schema changes require roundtrip migration tests (`npm run test:migrations`).

### V. Backward Compatibility & API Standards
- Standard OpenAI / Anthropic / Gemini wire protocol parity under `/v1` endpoints.
- Avoid breaking changes to existing proxy routes, status endpoints (`/livez`, `/readyz`, `/api/ping`), and dashboard APIs.

## Technology Stack & Constraints
- Runtime: Node.js (>= 20.18.0 < 25.0.0), TypeScript, ESM modules (`"type": "module"`).
- Database: SQLite via `better-sqlite3` with WAL mode.
- Frontend: React with Vite, Tailwind CSS, and Lucide icons.
- Build & Tooling: `concurrently`, `tsc`, `vitest`, `eslint`.

## Governance
- This Constitution supersedes unstructured coding conventions.
- All Spec Kit workflows (`/speckit-specify`, `/speckit-plan`, `/speckit-tasks`, `/speckit-implement`) must enforce these principles.
- Any amendment requires updating this document with explicit rationale.

**Version**: 1.0.0 | **Ratified**: 2026-10-31 | **Last Amended**: 2026-10-31
