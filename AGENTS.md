# AI Agent Guidelines & Upstream Synchronization Strategy

> **For all AI Coding Agents (Cursor Agent, Claude Code, Cline, Antigravity, Copilot, Codex, OpenCode):**  
> This repository is a custom extension of the upstream open-source project **FreeLLMAPI**. Read and strictly follow the architecture rules and synchronization workflow defined below before making any changes.

---

## 1. Repository Topology

| Remote Name | Repository URL | Purpose |
| :--- | :--- | :--- |
| **`origin`** | `https://github.com/thanhdo257205/freellmapi-custom.git` | **Main Workspace**: Where custom features, invite-system, and extensions live. All feature commits are pushed here. |
| **`upstream`** | `https://github.com/tashfeenahmed/freellmapi.git` | **Original Source**: The official FreeLLMAPI repository. Used strictly as a read-only source for pulling updates and bug fixes. |

---

## 2. Zero-Conflict Modular Design Rules (MANDATORY)

When implementing custom features (e.g., Invite Code System, Multi-User RBAC, Per-User Quotas):

### Rule 1: Standalone Files First
- **Services**: Create new files under `server/src/services/` (e.g. `invites.ts`, `user-quotas.ts`). Do not bloat existing service files like `auth.ts` or `proxy.ts`.
- **Routes / Controllers**: Create new router files under `server/src/routes/` (e.g. `invites.ts`).
- **Database Migrations**: ALWAYS generate a new timestamped migration file under `server/src/db/migrations/` (e.g., `YYYYMMDD_HHMMSS_custom_invites.ts`). **NEVER modify existing upstream migration files.**
- **Frontend Components**: Create dedicated components or pages under `client/src/` (e.g. `client/src/pages/Invites.tsx`).

### Rule 2: Minimal Touch Points on Upstream Files
When connecting your custom module to the existing application:
- Only touch the entry points (e.g., adding `app.use('/api/invites', invitesRouter)` in `server/src/app.ts`, or adding a navigation tab in the sidebar).
- Keep changes to existing files small, clean, and isolated.
- **NEVER** reformat, lint-fix, or refactor unrelated upstream code.

### Rule 3: Backward Compatibility with Existing Deployments
- Preserve all existing public endpoints (`/v1/*`, `/livez`, `/readyz`, `/api/ping`).
- Ensure single-user Docker / local deployment setups continue to function without errors.

---

## 3. Upstream Synchronization Workflow

Whenever instructed to "update from upstream", "sync with main repo", or pull latest changes from the original repository:

### Step 1: Pre-Sync Check
Ensure the local working directory is clean:
```powershell
git status
```
If there are uncommitted changes, commit or stash them before proceeding.

### Step 2: Fetch and Merge Upstream
```powershell
# 1. Fetch latest commits and tags from official upstream
git fetch upstream

# 2. Merge upstream/main into the current working branch (main)
git merge upstream/main
```

### Step 3: Conflict Handling (If Any)
Due to Rule 1 and Rule 2, merge conflicts should be rare. If a conflict occurs on an entry point (e.g., `server/src/app.ts` or `package.json`):
1. **Preserve Both**: Keep upstream's updates while preserving the custom router mounting or package dependency.
2. **Do Not Drop Custom Features**: Never discard custom modules in favor of upstream defaults.
3. Test the build immediately:
   ```powershell
   npm run build
   npm run test
   ```

### Step 4: Push Merged State to Origin
```powershell
git push origin main
```

---

## 4. Spec Kit & SDD Workflow

This repository uses **Spec Kit** for Specification-Driven Development:
- Configuration: `.specify/`
- Constitution: `.specify/memory/constitution.md`
- Skills: `.cursor/skills/`, `.claude/skills/`, `.clinerules/workflows/`

When asked to implement a new feature:
1. Run `/speckit-specify <description>` to generate the specification.
2. Run `/speckit-plan` to design the technical architecture.
3. Run `/speckit-tasks` to break down into actionable tasks.
4. Run `/speckit-implement` to execute code changes following the Zero-Conflict rules above.
