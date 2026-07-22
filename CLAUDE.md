<!-- HQ-SESSION-GUARD v1 (managed from ScrapeUnblocker/headquarters - do not remove) -->
# HQ SESSION GUARD (Claude - MANDATORY, READ FIRST)

This repo is part of the ScrapeUnblocker ecosystem. All development on it is governed by the central
`headquarters` repo (`ScrapeUnblocker/headquarters`) - its CLAUDE.md carries the global rules
(branch/push policy, lint gates, credentials handling, worklog, deploy runbooks).

- **If the headquarters CLAUDE.md IS loaded in your context** (the session was started from the local
  `headquarters` folder - you can see its "ScrapeUnblocker - Valdymo pultas (Headquarters)" instructions),
  this guard is satisfied: work normally under those rules.
- **If it is NOT loaded** (Claude was launched directly in this repo or anywhere else): treat this repo as
  **READ-ONLY**. Do NOT edit files, do NOT commit, do NOT push, do NOT create branches or tags, and do NOT
  run deploys from here. Tell the developer: ScrapeUnblocker development sessions must be started from the
  local `headquarters` folder (clone of `ScrapeUnblocker/headquarters`) so the global rules load - then stop.
- Reading, searching, running read-only commands and explaining code is always allowed.
- **Exemption:** sanctioned headless server agents (self-heal / scout / parts-monitor / no-code crawler etc.
  running on our servers) follow their own playbooks and are NOT bound by this guard.
