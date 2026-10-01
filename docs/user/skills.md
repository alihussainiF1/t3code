# Skills

Skills are folders of instructions (a `SKILL.md`, plus any scripts or
reference files it uses) that teach an agent how to do a specific job. Skills
you add in T3 Code reach every provider (Codex, Claude, Cursor, Grok,
OpenCode, and Antigravity) in new sessions, so you manage them in one place.

## Add skills

Open **Settings → Skills**.

- **Gallery**: choose **Install** on a skill from Anthropic's or OpenAI's
  public skill collections.
- **Install from GitHub**: paste a GitHub link. A link to a skill folder
  installs that skill; a link to a repository or a folder of skills installs
  every skill in it. Private repositories aren't supported.
- **New skill**: write a `SKILL.md` in the editor. Its frontmatter needs a
  `name` and a `description`; agents decide when to use a skill from its
  description, so say what it does and when it applies.
- **Import**: T3 Code lists skills you already have in `~/.claude/skills`,
  `~/.codex/skills`, `~/.agents/skills`, and, with a project selected, the
  project's `.claude/skills` and `.agents/skills`. Choose **Import** or
  **Import all** to copy them into T3 Code. The originals stay where they are.

Skills live on the environment, so skills added on a remote machine run there
and every device connected to it sees the same list. Mobile shows the list
read-only.

Choose **Update** to fetch the latest version of a skill installed from
GitHub, or to copy an imported skill again from its folder. Updating replaces
edits you made in T3 Code. To keep a skill away from some providers, choose
them in its editor.

## Use a skill

Agents pick up a skill on their own when a task matches its description. To
ask for one explicitly, type `$` (or `/`) in the composer and choose it; T3
Code skills are marked **Library**.

## Turn skills off for a thread

Use **Skills** in the thread's menu to turn a skill off for just that thread,
and the same menu to turn it back on. The change applies from the thread's
next message. Installing, editing, or switching a skill off in Settings
applies to sessions that start afterwards.
