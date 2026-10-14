# Codex for Agents

A bundled desktop plugin, on by default on macOS and Linux, using the native process host introduced in #731.
Agents owns the identity, admission, configuration, and signed Buzz actions. This plugin
owns Codex work after delivery handover. It starts one `codex app-server` for all
agents and uses an independent Codex thread for each agent's Buzz conversation.
Each thread carries its agent's workspace, instructions and tools, so one crash
fails every agent's current turn; the next mention reopens the server.

## Try it

From the feature worktree:

```sh
source bin/activate-hermit
BUZZODZ_PROFILE=codex-agents BUZZ_DEV_VIEWER= bin/just desktop
```

1. Codex is on by default; **Settings → Plugins** turns it off or on. An older
   profile that installed Codex from a folder gets the bundled copy instead, and
   keeps it off if the installed copy was off.
2. Open **Agents → New agent**, choose **Codex** in the card's top corner, and
   optionally pick a model beside it and add instructions. Name the agent and
   click **Create agent**.
3. **Agents → More → Provider settings → Codex** checks Buzz's copy of Codex and
   its account. If it says Codex is not installed, click **Install Codex**; if
   it needs you to sign in, click **Sign in** and finish in the browser. It also
   manages explicit-save model/thinking defaults. A blank agent choice inherits
   those defaults without changing its saved record. The **Workspace** defaults
   to `~/.buzz`, like Claude. In the agent's
   **Settings** tab, you can set an absolute or `~/…` path instead; clearing it
   restores the default. A disposable directory is useful for the first test.
   Choose model, thinking, session scope, and instructions, then **Save**.
4. Mentions are automatic; **Attention** also lets you add event
   watches. In a channel you can write to, select the agent from the `@` picker
   and add it to the channel if prompted. Send: `@Codex Test create hello.txt containing
   hello in the workspace, read it back, and report what you found`. Use the
   agent's actual name. Expect one reply from that agent in the originating
   thread and the file in your workspace.
5. Reply in the same thread: `@Codex Test read hello.txt and remind me what you
   wrote`. Expect the same Codex session and correct file contents.

While work is active, new mentions steer it, incorporating the follow-up into the
ongoing task. Messages arriving during startup wait for the turn to start and
then steer it; idle conversations continue the saved session. If a turn finishes
while a follow-up is being delivered, the follow-up starts another turn. A
follow-up that picks a model or effort other than the running turn's cannot
steer it, so it waits and runs as the next turn, and later follow-ups wait
behind it to keep their order.
A successful final send stops the request counting as working at once; Codex
still ends its turn with one more model call. Interrupting the turn instead would
leave a `<turn_aborted>` note in the session after every reply.
By default, Buzz tools reply to the latest accepted steering message. The agent can also choose another thread or channel with tool arguments.

There are no special chat commands. Asking the agent to stop is a steering request
that Codex interprets. Disabling the plugin ends its processes. For settings,
change instructions to require a marker, save, and send another mention after the
current turn finishes. Expect the marker.

Thread scope is the default. Channel scope shares a session across channel
threads; DMs always share a conversation. Workspace changes start a fresh session.
A mention in a chat filed in the owner's Me is one conversation whatever the
scope: the agent continues the channel's session and posts at its top level, and
its tools refuse a reply into a thread there. A turn keeps the routing it started
with, so a mention after the chat is shared waits for it and then threads as
usual. Watches keep their own routing.
Bindings persist locally under the community and agent identity. Earlier bindings without dynamic tools are ignored; new conversations start fresh. Switching
communities does not end an agent's work. Removing the agent, leaving or
disconnecting from its community interrupts its turns and asks Codex to end
shells they left running; the server ends when no
Codex agent that has worked is still running, or when the plugin is disabled.
If a saved Codex thread no longer exists, the next mention starts a fresh one.
To inspect a saved session, see [View a Codex session](../../../docs/view-codex-session.md).

The `buzz` dynamic-tool namespace exposes the same handlers as the Claude plugin:
`send`, `edit`, `react`, `read`, `channels`, `members`, `users`, `dm`, `mem_get`,
`mem_set`, `canvas`, and `media_get`, which answers with the image itself. These run inside Buzz through the agent's native-backed
handle; no MCP process or Buzz credentials go to Codex. Shared file tools use the
workspace where the turn started, through the declared `base64` reader. Memory
reads use the owner's encrypted-memory view; writes use the agent handle.

To test these locally, ask the agent to read its thread, react to your message,
remember a fact under `mem/test`, recall it in a follow-up, and send an image from
the workspace. Expect agent-signed actions, correct thread routing, and one final
reply. During a long task, send a new mention and confirm it incorporates the
follow-up before its final reply.

## Checks

```sh
bin/pnpm exec vitest run src/bundled/codex
bin/node src/bundled/codex/live.mjs
```

The opt-in live check uses the installed Codex CLI/account in a disposable
workspace and a simulated relay. It sends no Buzz messages. It checks native shell
and file tools, the native coding prompt, conversation context, default steering,
idle follow-ups, process shutdown, saved-thread reuse, changed and cleared
instructions, missing-thread recovery, and disabled inherited MCP tools. It also
checks real dynamic Buzz callbacks, memory, workspace file uploads, normal
final sends without aborted-turn markers, and two agents sharing one server with
their own workspace, instructions and replies. Set
`BUZZ_CODEX_TEST_MODEL` to another available model if needed. It prints only
sanitized outcomes; it does not save raw protocol or session logs.

Automated component tests cover provider defaults and precedence, model/effort
choices, unavailable saved choices, workspace validation, pending saves, and
cancelling a provider check during disposal.
Protocol tests cover chunking, request correlation, interactive request rejection,
malformed output, and consumer exception containment. Runtime tests cover
conversation routing, ordinary message delivery, persistence, defaults, failures,
and cleanup.

## Buzz's copy of Codex

The plugin never runs the `codex` on PATH. It runs Buzz's own copy from
`~/Library/Application Support/Buzz/codex/<version>/bin/codex`, or
`${XDG_DATA_HOME:-~/.local/share}/buzz/codex` on Linux; a `current` file names
the version in use. `~/.codex` is shared, so the sign-in and settings are the
same as in the terminal. [`codex.sh`](codex.sh) is the launcher and installer;
the plugin runs each step through the one declared `bash -c` process.

Releases come from OpenAI's channel, `releases.openai.com/codex/channels/latest`,
as `codex-package-<target>.tar.gz` with the sha256 the channel lists. After the
checksum check, Buzz runs `--version` and checks that `app-server` lists models;
only then does it switch `current`. A release that fails is skipped and the
previous copy stays in use. Switching takes a lock shared by every Buzz build,
which the system releases when the build holding it stops, and checks the copy
again once it holds the lock. It keeps the new copy, the previous one and any
newer one another build may be testing. A mention sent before Buzz has found a
copy, or while it downloads the first one, waits for it. If that download
failed, a mention tries it again.
Buzz checks when the agents load and every 6 hours; the first download (about
130 MB) waits until a Codex agent is running, or **Install Codex** is clicked.

## Limits and boundaries

- Only the owner's events start work. Event watches support those events; timers
  are unsupported and report an error.
- Replies use Agents' host signer. Codex receives no Buzz agent key and does not
  publish through the Buzz CLI. The shared Buzz base prompt, custom instructions
  and the agent's `core` memory are supplied as developer instructions, preserving
  Codex’s native coding prompt. Each turn reads `core` fresh through the shared
  `features/agent-harness` reader, as Claude does for each new session.
- Codex runs with sandbox `danger-full-access` and approval policy `never`, matching
  Claude's `bypassPermissions`: it can write outside its workspace, reach the
  network, and use git and `gh`. Web search, inherited MCP servers, Apps, and plugins
  are disabled.
- Shared Agent Activity integration is deferred because this Agents delivery
  contract has no live-activity API. The Runtime diagnostics disclosure in the
  agent's Settings shows conversation status and the latest command/output.
  Messages and uploads use the shared Buzz tools. Codex assistant text is not automatically posted. After `buzz.send` with `final: true`, Codex finishes normally and consumes pending steering. A turn that has nothing new to say ends without posting. Final sends preserve background processes, such as a dev server it started.
- Turns have a 29-minute deadline;
  RPC acknowledgements have a 30-second deadline. Local bindings retain 200 sessions.
- Uses experimental app-server APIs for dynamic tools, model discovery, application context, and terminal
  cleanup. The live check was exercised with `codex-cli 0.162.0` on macOS.
- Linux and Windows native behavior, packaged app behavior, full relay signing,
  and human acceptance require separate validation. A forced native kill can
  depend on the platform's descendant-cleanup support; this plugin adds no host
  process implementation.

Keep the PR in draft until the agent and human exercise the native mention/reply
flow, including signer behavior and process shutdown. Do not add
`buzz-review-completed` before the repository's review checklist holds.
