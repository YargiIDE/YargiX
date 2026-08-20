# You stay in control

An agent that edits your repository is only useful if you can undo it. YargiX has four independent safety nets.

## Approve what matters

Every shell command, file write and network call goes through a policy you set: **allow**, **ask**, **review**, or **deny** — per action type, with wildcard allow/deny lists.

**Review** mode is the useful default: it runs the tame things silently and asks about the risky ones (`rm -rf`, `sudo`, `.env`, credentials).

A denied command cannot be smuggled through by chaining: `git add -A; git commit` is checked one command at a time.

## Keep or undo, hunk by hunk

Every agent edit gets **Keep / Undo** CodeLenses right in the file. No git required.

## Review the whole change

The **Changes** view lists every touched file with its added/removed counts. Keep or undo them individually, or all at once.

## Rewind the entire run

If a run went wrong, **YargiX: Rewind to Checkpoint** puts the workspace back exactly as it was before it started — and takes a checkpoint first, so the rewind itself can be undone.

---

Planning something big? **Plan** mode writes the plan first and **asks for your approval** before it is allowed to touch anything.
