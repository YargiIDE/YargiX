# Where to go next

## See what you built

Ask the agent to open your dev server and look at it. The **Browser** tool drives a real Chrome/Edge, takes a screenshot the model can actually read, and reports console errors — so it can verify the UI it just wrote instead of assuming.

## Give it a memory

`.yargix/memory/` holds notes the agent keeps between sessions: how the project builds, why a module is shaped that way, the trap that cost you an hour. It is a normal folder — commit it and your whole team shares it.

## Send in a team

**Project** mode makes the agent a lead that delegates to specialists — product manager, architect, frontend, backend, database, QA, code reviewer, security. Each works in isolation and reports back.

## Run it from a terminal

The same agent works headless:

```
yargix "review the uncommitted changes" --mode review
yargix                      # interactive session
yargix "fix the build" --auto --json    # for CI
```

Nothing that changes files runs unattended without `--auto`.

## Wire in more tools

**Settings → Tools & MCPs → Browse catalog** adds Model Context Protocol servers in one click. YargiX can also act as an MCP *server*, exposing its own tools to other editors.

---

**Community:** [Telegram channel](https://t.me/YargiIde) · [Telegram](https://t.me/YARGI_LEAKS) · [YargiEngine.com](https://yargiengine.com)
