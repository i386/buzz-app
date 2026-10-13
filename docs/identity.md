# Packaged human identity and relay access

Native macOS, Windows and Linux without the live development broker offer
**Use an existing key** or **Create a new identity**. These are alternatives. Import accepts an nsec,
validates its checksum and secp256k1 scalar, and persists that exact key before
adopting its public identity. It never generates a replacement after an import,
read or write failure. Denied/unavailable/corrupt storage is not first run.

One native owner keeps the key in memory after successful restore. The new
create-only secure-storage item is service `dev.local.buzz.foundation.identity` in release
builds, or `dev.local.buzz.foundation.identity.debug` with Rust debug assertions,
account `human`. Debug worktrees share the debug item, not the release identity;
ports and frontend dev mode do not isolate it. macOS keeps its existing default
file Keychain/security-framework implementation. Windows uses Credential Manager;
Linux uses Secret Service through keyring 3.6.3, as old Buzz does. Linux requires
a running desktop Secret Service with a default collection (for example GNOME
Keyring), reachable on the user's session D-Bus. Missing, inaccessible or ambiguous
storage fails closed: unlock/configure the store and explicitly retry.

Human storage does not use or change agent credentials or old Buzz's
`buzz-desktop/secrets` blob. A competing item refuses overwrite. Windows/Linux
creates and agent deletes share a per-user, service/account file lock under the
OS account's home `.buzz-foundation/credential-locks`, independent of HOME/XDG,
profile and worktree overrides. Lock files are empty, retained, and never hold keys;
a busy lock reports a retryable error rather than waiting behind another process's
consent dialog. Locks serialize cooperating Buzz instances, not arbitrary other
programs or other machines. Windows credentials use keyring's enterprise persistence
and may roam under Windows policy; locks do not coordinate machines.
Neither Windows Credential Manager nor Secret Service supplies per-app access
isolation from other programs running as the same OS user.

There is no file/environment fallback, automatic legacy migration or human key
replacement. The human key is deleted from this device only by
[Sign out of Buzz](#sign-out-of-buzz); no other command or plugin service can
delete it. Agents' bring-over (`app_agent_port`) may read only the selected
old Buzz service/account and copy the selected agent key into this app's separate
agent namespace; it never writes the old blob.
No user key belongs in release configuration.

A shared credential blob can reduce repeated OS prompts by caching many credentials
after one read. For this one human key, one cached item retains that read-once benefit without
coupling human writes to agent credentials or old-app blob writers. This is not a
claim that per-secret storage is always superior or that prompts are eliminated.
Consent, app signing and update behavior require attended native verification.

## UI and sensitive data

Settings exposes Profile in Personal space as well as in a selected community.
Identity details remains available if the community profile cannot load. The full
npub and hex public key can be copied. The nsec is absent from the rendered field
until Reveal; Copy can fetch it without revealing it. Hide, leaving Profile,
window blur and document hiding retire pending reveals and clear the displayed
secret. Failed private-key actions report fixed errors. Copy deliberately leaves
the key on the OS clipboard; the UI warns about that.

The app UI passes a private string through IPC only during explicit import/export
interaction. JavaScript/IPC string memory is not guaranteed zeroized. Native
key bytes and temporary storage buffers use zeroizing owners, but this is not a
claim that every framework allocation is wiped. No secret is put in public
snapshots, plugin service registrations, localStorage, logs or relay events.
The main app and its same-origin plugins are trusted, not isolated security
principals; plugin JavaScript can invoke `identity_export` directly. Not registering
a plugin key service is an API ownership choice, not a sandbox. The main-webview
command permission is not proof of a human gesture.

## Sign out of Buzz

Settings → Profile → **Sign out of Buzz** removes the private key from this
device only; the npub and its history stay on relays. The dialog presents two
layers: the key always goes, and settings, agents and other Buzz data stay unless
the user erases them. It embeds the private-key controls above. Confirm stays
disabled until the user reveals or copies the key and ticks "I have my key".
**Also erase everything else Buzz stores on this device** (internally, wipe)
requires typing `erase all my data`; **Also remove my agents** appears only with
it; the button then reads **Sign out and erase**. Wipe clears
this app's data, local data, WebView storage, caches and plugin storage. It cannot
reach the clipboard, exported keys or relay data, and the dialog says so. Sign out
is unavailable with the development broker (`BUZZ_DEV_VIEWER`). Development
builds can sign out but not wipe: they have their own human key, but share agent
keys and plugin storage with the installed app, so the native command refuses
wipe. The dialog asks the native side (`sign_out_wipe_refusal`) whether wipe is
available and, when it isn't, disables wipe up front with the reason; this holds
for any Rust debug build, including a debug bundle with a production frontend. A development-build sign-out signs out every
development build, which share the debug key, and leaves the installed app
signed in. Wipe is unavailable while
`BUZZODZ_HOME` moves plugin storage out of app data.

Every running instance, debug or release under any identifier, holds two locks
shared in the user data folder (created first if a first launch finds none)
before it looks for a pending sign-out:

- a **key lock** named for its human key store (`.<service>.instance.lock`), shared
  by every copy using that key whatever its identifier; and
- the **all-Buzz lock** (`.dev.local.buzz.foundation.instance.lock`), named for
  the storage all builds share (the default plugin folder and the agent key
  service), not for the app identifier.

A sign-out needs its key lock alone, so every other copy using that key must be
closed. A wipe also needs the all-Buzz lock alone, so every other Buzz must be
closed. A development-build sign-out therefore needs only other development
worktrees closed, not the installed app, and the installed app's plain sign-out
doesn't need development builds closed. Locks are taken key first, then
all-Buzz, released in reverse, and never waited for while one is held alone.
Whenever an instance takes its locks shared again (after finishing a pending
sign-out, or after a refused sign-out), it looks for the marker again: at launch
a new marker is finished in turn; in a running instance it means another process
committed a sign-out, and Buzz exits natively (see below). A running instance
also exits if the sign-out record (`.<service>.sign-outs-finished`, kept forever
and shared by every identifier using the key) changed since launch: another
process finished a sign-out of its key while it let go. Retaking them
shared is bounded too; on timeout, or if a lock can't be let go, Buzz exits the
same way. These locks
coordinate running Buzz 1.0 app copies only: `buzzodz plugin sign` reads the
human key without them, and older Buzz versions don't take them, so close those
before signing out. The native
`sign_out` command deletes nothing: it admits one sign-out per instance, refuses
unless it can hold the locks it needs alone, writes a marker beside (not inside)
app data recording the wipe and agent choices, and restarts; agent processes
stop as they do on Quit. The marker is named for the exact human key store
(debug or release), so another build never acts on it. If the marker can't be
written nothing has changed; if a later step fails, Buzz exits natively, and the
next launch finishes the sign-out.

Once the marker is written, and before any native exit, the native signer is
closed for the rest of the process: the cached key is dropped, and every key
operation (signing, agent authorization, export, restore, import or create)
refuses when it runs, including calls that started before it closed. Pairing
closes in the same close step: the live attempt is cancelled before it can publish a
payload it already prepared, and no new attempt starts. Work admitted before
the close isn't recalled: a payload admitted before pairing closes may still be
sent or delivered (an outcome not yet known is reported as uncertain), and signatures and agent authorizations
already issued remain valid. A native exit runs the same best-effort teardown as Quit, then shows a native
alert and exits however that went; the dialog never offers a retry or Cancel
once this instance's locks or agents are in an unknown state. Agents don't
outlive Buzz: each runs under a supervisor that stops it when Buzz's socket
closes, holding that agent's ownership lock (`dev.local.buzz.agent-ownership`
in the user data folder) until it has stopped. A supervisor that can't stop its
agent keeps the lock.

A launch that finds the marker takes its key lock alone, and for a wipe the
all-Buzz lock too, waiting briefly for the exiting instance, then reads the
marker once more and runs only choices those locks cover: if it has meanwhile
become a wipe, the launch lets go and starts over to take every lock. Before a
wipe, it tries every agent ownership lock; if any is still held, it removes
nothing and exits with a native alert that an agent is still stopping, so a
later launch retries. A plain sign-out skips this: it removes only the human
key, and the ownership folder is shared with every Buzz, so another copy's
running agents would block it. A marker
that can't be read or parsed fails closed. It finishes before any window,
webview storage, service or identity read:

1. With remove agents, every agent's locally stored key is deleted, read from
   the agent registry, which stays in place until all are gone. That includes
   imported deployed-remote agents, whose import kept a local copy; the remote
   deployment itself is not stopped or deleted.
2. With wipe, app data, local data, WebView storage and caches are renamed
   aside. App data's agent folder (`agent-controller`) is put back unless agents
   were removed.
3. The human item is deleted and a fresh read must find it absent.
4. The renamed folders and anything recreated in place are deleted, then the
   sign-out record advances, then the marker is removed. Kept agents keep only
   what they need to be identified and start again: the agent list with their
   settings (`agents.json`), the shared agent defaults (`defaults.json`),
   including any API keys entered in their settings, and their keys in the
   keychain. Everything else in `agent-controller`, including saved Databricks
   logins, logs and anything added there later, is deleted; a kept Databricks
   agent must sign in again. The dialog says both.

Every step is safe to repeat: deleting an absent key succeeds, and an agent
registry confirmed absent means its keys are already gone; failing to check it
stops before anything moves. The wipe never acts through a link at Buzz's own
folders: every wiped folder, its `.sign-out-trash` sibling, the kept
`agent-controller` in both, and the agent list when agents are removed must be a
real folder or absent. This is checked before the marker is written, before
anything moves, and again right before every move, rollback and delete. The OS
storage folders above them (`Application Support`, `Caches`, `~/Library/WebKit`)
are trusted as the app already trusts them, so if one is a link the wipe removes
only Buzz's folder under it. The wipe is not designed to resist another program
swapping folders while it runs. Every other presence check in the wipe is fallible
too: one that can't look fails the attempt, keeping the marker. If renaming or the key delete fails, the renames are rolled back. On any failure
the marker is kept and Buzz shows a native error and exits without opening a
window, so nothing recreates wiped storage and the next launch retries. Without
wipe, local data stays: it is already scoped by public key, so signing back in
with the same key finds it. Builderlab and hosted-community logins live only in
memory and end with the restart. Kept agents start only while the signed-in key
matches the owner in their saved attestation, checked before their key is read.

## Packaged connection

A public native viewer hydrates the existing public-key-scoped local profile and
memberships. On macOS, Windows and Linux, app composition supplies the shared
native relay adapter after identity restoration. Windows/Linux installed-app
transport acceptance remains unverified. Only the selected saved community opens on restart; Personal
space stays disconnected. Discovery failure leaves the community retryable.
Native sessions do **not** fall through to the dev broker signer.

The native identity owner signs event templates and authenticates HTTP with
NIP-98, including the exact request URL, method, a body hash on POST and a fresh nonce
for each attempt. Native networking permits only discovery, join-policy, invite
mint/acceptance/claim, relay-advertised GIF search, query, event and bounded
workflow run-history routes on HTTPS origins, with bounded bodies, timeouts and
no redirects. JavaScript never obtains the private key for transport.

Relay staff console requests (`relay_admin_*`) use a separate native owner.
The admin origin comes only from the selected relay's NIP-11 `admin_api` and
must be a public HTTPS host. Every probe, read, write, attachment fetch and
retry resolves that host, refuses the request if any answer is loopback,
private, link-local or otherwise reserved (or if DNS fails or returns nothing),
and connects only to the vetted addresses while keeping the hostname for TLS
and NIP-98. That client ignores system proxies and follows no redirects. The
webview names a closed route; native code builds the URL, checks the request's
expected relay, admin origin and signer before signing, and caps each response.
NIP-11 `self` establishes relay authority; the operator-contact `pubkey` is not
a substitute. The existing live owner handles WSS/NIP-42 authentication and
signature verification. IPC permissions remain limited to the main WebView.

Channel lifecycle/details and identity archive commands, channel recipe preparation/decoding,
and opening direct messages use purpose-bound native commands. Creation kind 9007 is
advertised only when NIP-11 reports NIP-29 support. NIP-44 stays in the native
identity owner; recipe plaintext is never returned by a generic decrypt command.

Community admission, kind-0 profile reads/publication, the NIP-43 leave request
(kind 28936, signed only in its empty protected shape) and the adapter's advertised
message/event writes use this identity. [Join recovery](communities.md#packaged-admission-and-recovery)
records public progress before remote changes. The existing durable outbox retains
uncertain delivery across restart; retry uses the same signed event with fresh HTTP
authentication. Events older than 15 minutes get a strong ID readback instead of
being republished or silently re-dated. Missing/failed readback retains uncertainty;
the user must inspect the conversation before explicitly sending a new message.

Protected media and uploads are native, because the webview cannot attach Blossom
(kind 24242) authentication itself: `<img>`, `<video>` and `<audio>` send no custom
headers, and the CSP keeps `connect-src` closed to general HTTPS. Relay `/media/`
URLs selected by shared TypeScript render through the `buzz-media` URI scheme;
`<video>` and `<audio>` instead load the same URLs from a native listener on
`127.0.0.1`, since WebKitGTK cannot play a custom scheme. It authorizes each
request by a random per-launch path token given only to the main window, the
bound `Host` and the app's `Origin`, and serves one request per connection.
Both validate HTTPS and the `/media/<hash>` URL shape but do not enforce
saved-community membership; the selected server receives a short-lived token
scoped to its origin. The scheme signs a fresh 60-second `get` token per request
and forwards only a bounded single `Range`; non-image/video/audio types (and SVG)
are served with download disposition and `nosniff`. The main webview does not navigate to protected media for downloads: a narrowly scoped native command authenticates the bounded media GET, saves to the OS Downloads directory without replacing existing files, and rejects unsafe filenames. `relay_upload`
hashes, signs (`upload` + `x`) and sends the exact bytes JavaScript passes it;
shared TypeScript (`hostUpload`) owns limits, error mapping and descriptor
validation. JavaScript never signs kind 24242. Packaged HEIC and video
preparation uses fixed demuxers and ffmpeg arguments in the native host, then
hashes and uploads only the converted bytes; JavaScript receives the descriptor,
not the prepared file. ffmpeg must be installed on the computer.
Community member changes (NIP-43 kinds 9030–9032) are signed in the host only
in the exact add/remove/role shape; the relay decides authority. Repository HTTP
and other broker-only helpers are not claimed by this adapter. NIP-FI assertion
acquisition is not implemented, so deployments enforcing it are outside acceptance.
Windows/Linux custody, credential migration and release-signing acceptance remain
separate limitations.

Development with a public `BUZZ_DEV_VIEWER` pin enables the legacy broker
(Vite derives `VITE_BUZZ_LIVE=1`), even inside `just desktop`, and does not offer
native private-key controls. `just desktop` passes Vite's effective public pin
(including an explicitly empty shell override) to the native app. The public pin
alone is not authorization. Packaged builds always use native identity, ignoring
the pin. This reuses the broker's trusted-local-process boundary; it does not copy
keys or introduce another signing protocol.

Without the pin, supported desktop development uses
the native identity path; see the [host-mode matrix](contributing.md#shared-logic-and-host-boundaries). Creating/importing the
new native item does not update that old blob. Future reset/rotation would not
synchronize copies automatically; neither operation is in this scope. Sign out
does not touch that old blob.

## Try the UI without credentials

Use the existing environment-free fixture Vite config:

```sh
bin/pnpm exec vite --config tests/fixtures/agent-control.vite.mjs --port 1547
```

Open `/tests/fixtures/identity.html`. It uses mock IPC and an in-memory public
fixture key, not an OS credential store or a relay. Import accepts only the
displayed fixture key. Reset and simulated restart affect fixture state only. **Never enter a real
nsec.** Browser exercises prove UI behavior, not secure native persistence.

Before real-key use or a usable-release claim: independent custody review,
isolated native consent/denial/import/create/restart checks, human UI feedback,
and installed-app live read/send/receipt/restart acceptance are still required.
Do not launch/restart someone's desktop app or inspect their credentials to test.

### Windows/Linux native acceptance (not established by the fixture)

Use a disposable **OS account/VM**, not a profile, port or HOME override: credentials
are per OS user. Use only throwaway keys, keep old Buzz closed for import handover,
and do not connect that identity to a real community for this storage check.

- On Windows and Linux with a working Secret Service/default collection, create
  or import, export the throwaway key, quit/relaunch, and confirm the same public
  identity and export. Repeat separately for debug and release builds.
- With an existing Linux key locked, dismiss the unlock request. Expect a storage
  error/retry, not first-run create/import choices; unlock and retry to restore.
  Without Secret Service, expect an error rather than key generation/fallback.
- Where two development instances can run, an occupied human/agent item must not
  be overwritten. Lock contention must be retryable; after exit, locks release.

Deferred until agent import is reachable from the UI on Windows/Linux:
explicitly import a throwaway old-Buzz agent, restart and verify the exact key,
then delete only the destination agent and verify the old source remains. This is
not a reachable UI acceptance step for this storage slice and does not establish
Windows execution.

Attended Windows/Linux execution and human confirmation are release gates, not
claims made by cross-compilation, fake-store tests, or the browser fixture.
