Codex tiles: stop the rows overlapping
------------------------
The labels were drawn on top of the row below. Three causes, and each one hid the next,
so fixing them in the wrong order proves nothing.

The label was a flex child competing with the image for a fixed square.
.item-card-image carries `flex: 0 0 auto`, so it kept its full height, the 24px label had
nowhere to go, and it rendered half outside the tile. The image is pinned to the tile and
inset from the bottom by the label's height, so the two can no longer contend.

The label is inside .item-card-body, not a direct child of .item-card.
A `>` combinator matched nothing, so the first attempt at this fix did nothing at all,
silently. The body is pinned to the bottom of the tile and out of flow, so it cannot add
height either.

The row tracks were the wrong height, and this is the part that was not obvious.
The tile is a square via `aspect-ratio: 1 / 1`, and aspect-ratio sizes the box, not the
grid track. With the image and the label both out of flow the track has no content left to
measure, so it collapsed to the 176px min-height while the tile itself rendered at 206px.
Every row then drew 18px over the one above it, which is exactly the height of the label
strip, so the labels landed on the row below.

`grid-auto-rows: auto` cannot fix that. An auto row sized by a square child is circular
and resolves to the content, which is now nothing. The track height has to be stated, and
it is stated per breakpoint to match the column floor styles.css sets at each width.

Worth recording, because it cost the most time: an earlier fix in this file had set
`min-height: 0` on .item-card, which is what collapsed the tracks to about 3px in the
first place, and restoring the 176px floor appeared to fix it. It did not. The floor
stops a track collapsing; it does not make the track the right height, and the symptom
that remained was an 18px overlap rather than a total collapse. Both looked like the same
bug and only one of them was.

The "More Items Ready" placeholder carries .item-card as well, and it is deliberately a
different thing: its own 236px floor, its own flex column, and it sits alone on the last
row by design. Every rule here is scoped away from it, since pulling it out of the flow
would have left an empty cell where the button is.

Verified: 121 tiles, 20 rows of 6, no label outside its tile, no label overlapping
another, and the grid scrolls to its full height.

## Surfaces show edges where corners were asked for

Reported from the running app: panels, the rail and the floating windows still read as
rectangles with a border, where the intent everywhere else in this app is a rounded
surface that sits inside the window rather than a box drawn on it. The panes were fixed
(14px, all four corners, in 24e2e4c) and the riven detail card with them, but the change
was made rule by rule rather than from a single definition, so anything that draws its
own border still has square corners and anything that inherits a background from its
parent inherits it square.

What is actually wrong, in three parts:

1. There is no shared surface definition. `border-radius` is written per component, so
   a new surface defaults to 0 and nobody notices until it is on screen next to a rounded
   one. A `.surface` class holding the radius, the border and the background token would
   make the default correct and leave each component free to override it on purpose.
2. Some surfaces clip their content with `overflow: hidden` and no radius, which squares
   the corner of the first child even when the parent is rounded. The radius has to be on
   the element that clips.
3. Where a surface touches the window edge, the window's own corner is the only round one.
   A rail flush to the left edge cannot be rounded on the left and stay flush, so the
   choice is between an inset panel with all four corners and a full-bleed strip with two.
   This is the same argument as the panes, and the panes went inset, so the rail should
   too.

Not yet done. The rail is the visible case and is being handled first; the floating
windows and the modal surfaces are the remaining ones.
