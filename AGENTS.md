# AGENTS.md

## Architecture

Check [STACK.md](STACK.md) when present. The engine is described in [CORE.md](CORE.md).

## Project management — RECORD/

Plans, decisions and walkthroughs live in [RECORD/](./RECORD/). Convention:

- Name format: `YYYY-MM-DD.<summary>.WIP.md` while open, `YYYY-MM-DD.<summary>.completed.md`
  once closed. `<summary>` is a kebab-case slug of the topic.
- **`.WIP.md` files are append-only.** Extend them at the end, with the date and time of the
  extension and a summary of what it adds. Existing content MUST NEVER BE DELETED OR MODIFIED.
- **`.completed.md` files are read-only.** A follow-up goes in a new record that links back.
- For a new topic with no relation to previous ones: create a new record.
- Records are always written in English.

## Critical Rules

### Record-first workflow
**Never make changes without first documenting them in a record.** This is non-negotiable.
Before implementing any feature, refactoring code, or adding dependencies:

1. Create or extend the appropriate `.WIP.md` record in `RECORD/`
2. Document the planned changes in detail
3. Wait for user approval before proceeding
4. A record is completed only when the user explicitly says so. Then append the final
   walkthrough and rename it from `.WIP.md` to `.completed.md`.

## Tasks

- When a task is done, append a walkthrough of what was done to the current record, and
  suggest a 1-line commit message in English.

## Ending sessions

When the user says **"capitular"**:

1. Complete the current record (walkthrough, rename to `.completed.md`) and update `README.md`
   with the project specifications (in -# Project Specs- section) and a todo list (in -# Todos-
   section if exists).
2. Ask the user to start a new session.

## Temporary files and scripts

For temp files and folders, use `.tmp/` into project root.
Temporary scripts should be created in `.tmp/scripts/`.
