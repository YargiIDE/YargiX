# Edit without leaving the file

Select some code and press **`Ctrl+I`** (`Cmd+I` on macOS). Describe the change in plain language:

> add error handling
> convert this to async
> extract this into a helper

The selection is rewritten in place.

## Propagate the change

After an edit, press **`Alt+Enter`**. YargiX looks for the other places that need the same change, and walks you through them one keypress at a time — `Alt+Enter` applies and jumps to the next, `Alt+]` skips.

The model only ever chooses from locations found in your workspace, so it cannot point at a file that does not exist.

## Ghost‑text autocomplete

Copilot‑style completions as you type, powered by whichever model you selected — cloud **or** fully local.

It ships **off**. Turn it on from the command palette: **YargiX: Toggle Inline Autocomplete**.
