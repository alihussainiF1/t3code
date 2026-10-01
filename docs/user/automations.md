# Automations

An automation is a prompt T3 Code runs for you on a schedule, in one of your
projects. Use it for recurring work like triaging new issues every morning or
checking a build every hour. Runs happen on the server, so they keep going
while the app on your laptop or phone is closed.

## Create an automation

Open **Automations** from the sidebar (or **New automation** from the command
palette) and choose **New automation**. Pick:

- **Project**: where the agent works. Runs use the project's main checkout.
- **Prompt**: what the agent should do each run.
- **Model** and **Permissions**: the same choices as a new thread. Runs start
  with nobody watching, so choose the permission mode you are comfortable
  leaving unattended. See [Permission modes](./permission-modes.md).
- **Schedule**: hourly, daily, weekdays, weekly, or a custom five-field cron
  expression. The dialog shows the next three runs so you can check it.
  Times are in the time zone shown, which defaults to yours.
- **Each run**: start a new thread every time, or keep continuing the same
  thread.

**Run now** starts a run immediately without changing the schedule.

## Review results

Each run creates or continues a thread named after the automation and the run
time. When the run finishes, the thread shows as unread in the sidebar and you
get the usual completion notification. Open **History** on an automation to
see every run and jump to its thread.

## Things to know

- **One run at a time.** If the previous run is still working when the next
  one comes due, that run is skipped and history says so.
- **Missed runs.** If the server was off when a run was due, it runs once when
  the server comes back, as long as that was within the last 24 hours. Several
  missed runs never pile up into a burst; older ones are recorded as skipped.
- **Pausing.** Turn an automation off to stop future runs. Turning it back on
  resumes from the next scheduled time without catching up.
- **Deleting** an automation removes its schedule and history. Threads from
  past runs stay in the sidebar.
- On mobile, **Settings → Automations** lists your automations so you can
  pause them, run them, and open recent runs. Create and edit them on desktop
  or the web.
