---
title: Sign in with Nouverse
description: Self-hosted editions sign in with a local password; Nouverse sign-in is in the Pro edition only.
---

The self-hosted editions, Community and Router, sign in to the dashboard with a local password, and
the CLI reaches the daemon with a control token kept in `.nouride/data`. Nothing about signing in
leaves your machine.

**OAuth ("Sign in with Nouverse")** is not in them: the flow is not compiled in, and setting `NOURIDE_OAUTH_ISSUER` makes the daemon refuse to boot rather than ignore it. It exists only in the Pro edition.

For self-hosted deployments, access is managed entirely by you: the dashboard's local account, who may talk to the agents (`nouride access`), and tool approvals (`nouride approvals`, or the dashboard).
