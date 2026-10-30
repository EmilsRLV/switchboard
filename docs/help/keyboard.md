# Keyboard & palette

Everything Switchboard does is a command. Every command is in the command palette, and any command can have a
key. Buttons, menus and keys all run the same commands, so whatever you can click you can also type. For the
canvas's own keys, see [Selecting and acting](canvas.md#selecting-and-acting).

## The command palette

Press `ctrl+k` to open the command palette. Type a few letters of a command's title to filter the list, move
with the up and down arrows, and press `enter` to run the selected command; `esc` closes the palette. Only the
commands that make sense right now are listed: **Show terminal** appears only with a session node selected
whose session runs in a terminal pane, for example. A command's key, when it has one, shows at the right of its
row.

Some commands open the palette as a pick list instead, such as **Link to…** or **Help: open page…**: type to
filter, then `enter` picks.

## Help

`f1` opens and closes this Help pane, as does **Help** in the palette. It opens on the page for the pane
that is open or the node or edge that is selected, else the page you last read; closing it brings back the pane
it covered, as you left it. **Help: open page…** jumps straight to
a page and **Help: contents** returns to the list of pages. `esc` closes the pane, like every pane.

## Keys in a terminal

While a terminal pane has the focus, keys belong to the program running in it: `esc`, `ctrl+k` and `f1`
all go to the terminal, as do copy and paste. A few keys still reach Switchboard:

- `ctrl+shift+k` opens the command palette; from there, **Help** opens this pane.
- `` ctrl+` `` shows or hides the terminal pane.
- `ctrl+pageup` and `ctrl+pagedown` switch between terminal tabs.

## Changing keys

Keys live in `keybindings.json`, beside `settings.json` in Switchboard's config folder. Each entry names a
command id and its key, or `null` to remove the key:

```json
{
  "help.toggle": "ctrl+h",
  "attention.next": null
}
```

The file reloads as soon as you save it. Settings → Diagnostics lists any errors and conflicts in it.

## All commands

The table below lists every command with the key it has now, after `keybindings.json`; a dash (—) means no key.
Key-only commands, which the palette does not list, follow it.
