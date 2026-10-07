# Dialog

Dialogs confirm consequential actions; they float on `overlay` with `shadow-overlay`.

- Title in `display-md` as a question naming the thing: "Delete history for Public API?"
- Body says exactly what is removed and what stays, with real counts.
- Irreversible deletes ask the person to type the monitor name before the danger button enables.
- Actions sit bottom-right: "Cancel" (secondary) then the action, whose label repeats the title's verb ("Delete history").
- Escape and the scrim close it; focus returns to the button that opened it.

The consumer provides the title, body, confirmation text and the action handler.
