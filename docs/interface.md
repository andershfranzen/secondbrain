# Interface direction

The home screen answers one question: “What do you want to put down or find?”
It opens with one composer. There are no capture, recall, or history tabs, greetings,
suggested prompts, counters, or dashboard cards. This overrides the earlier screen
layouts in the implementation specification.

- Objects: original text and audio, saved questions, sourced answers, uncertain memories.
- Data: the user's real captures; an empty account stays empty.
- Audience: one person, often on a phone, returning without needing to organize first.
- Main job: write or record immediately; ask for earlier information in the same box.
- Saved brain dumps get "Saved" and one quiet row per recorded change (a new
  commitment with who asked and when, something marked done), never an essay.
- Answers appear in the same stream; every claim links to the user's own words.
- Earlier conversations expand in the same workspace from the secondary menu.
- Records, corrections and settings remain secondary. There is no review queue:
  the agent decides, and labels what it is unsure about as unconfirmed.
- Unsaved composer text survives opening settings or a source.
- Recordings retain retry and download controls after upload errors.

Taste Skill v2 (`design-taste-frontend`) installed from Leonxlnx/taste-skill.
App-screen draw: Achromatic ledger, seed 1252092552; no redraw. Existing type retained. The user's always-dark OLED direction overrides the sheet's light palette: true black
canvas, off-black working surfaces, white text/actions, and neutral gray metadata.
No theme switch or system-theme override. No-sidebar shell. Product identity comes from the editable, quiet
writing surface and exact source excerpts attached to answers. No sample data is
rendered in production. The explicitly requested input-only home takes precedence
over the skill's default workspace greeting, tiles, large canvas, and visible heading.

There is no routing in the client. Every message goes to one agent turn that
decides whether it was a note, a question, both, or an instruction, and acts on
it (see [agent.md](agent.md)). The message is saved before the agent runs; the
turn's status shows as "Saved · working on it" until the reply arrives. Questions
are preserved but never become evidence. If processing is off, the message is
still saved and keyword matches from earlier notes are shown instead.

The composer is one rounded box with icon controls (record, attach, send) and the
same size centered or docked. It grows with its text. Enter sends on keyboards
with Shift; on touch keyboards Enter is a new line. The unsent draft survives a
reload or expired session in the same tab.

Visual critique: the composer is the largest and first working element. Header
and composer share the same edges. No ornamental color or invented content is
used. The inspector's whitespace warning is intentional: the user explicitly
requested that the landing page be essentially one input box. Menus have 44px
hit targets and the phone keeps the same single-column interaction.

Motion is one system with shared tokens (160/280/420ms, one ease-out curve, an 8px
rise). Content that appears in place (statuses, answers, errors, recording strips,
expanded conversations, edit forms) opens and closes by height. View changes
crossfade with the View Transitions API; the header stays put, the composer glides
between centered and docked, and views open at the top while the conversation
keeps its scroll position. Lists stagger in, disclosures animate their height,
the saved check draws itself, and loading text waits 200ms so fast responses never
flash it. Recording and pending status use a small opacity pulse.
All motion is removed by `prefers-reduced-motion`. The web manifest, mobile browser
chrome, icons, native form controls, and offline page use the same monochrome theme.
