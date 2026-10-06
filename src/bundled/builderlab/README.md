# Builderlab

The bundled `block.builderlab` plugin adds Settings → Integrations → Builderlab.
With a valid `BUZZ_BUILDERLAB_URL` build input, it also registers
`block.builderlab/builderlab` in Agents' new-agent type picker.
`adapter-type/` connects this hosted type to Beekeeper: provision registers the
agent, activation submits the owner proof and community supplied by Agents, and
removal deletes the provider runtime. Agents owns unfinished setup recovery and
the runtime-tagged community registration; the provider keeps the key and runs
the agent even while Buzz is closed. On desktop, Create agent and confirmed
deletion start browser sign-in when needed, then continue the action. Both share
an existing Settings sign-in attempt; a failed or canceled login leaves the
action available for retry. Settings still provides sign-in and sign-out.
Canceling an action's wait does not cancel a shared login; disabling the plugin
or closing Buzz cancels it.
The agent's Instructions tab reads its current instructions from Builderlab and
saves changes directly to the provider. Loading and saving use the same login;
failed saves keep the draft, and switching accounts requires the original
account before saving. Empty instructions can be saved to clear them.
Profile updates remain TODO and report an unsupported-operation error.

The adapter retains the provider agent ID, server, verified account subject and
provisioning replay reference in `buzz.builderlab.adapter-identity.v1:` records.
No credentials or owner proofs are saved. These records survive restart and
deletion so retries can confirm an already-missing runtime without assuming
absence from another account's list. Registration retains its replay UUID until
Agents has saved unfinished setup and begins activation, or provider deletion
is confirmed. On another device, removal resolves the ID from the signed-in
account's list; an unknown key is refused. Existing Settings-created
agents are not migrated into this type.

- `oauth/` owns browser handoff, code exchange, account verification, and the
  plugin-lifetime session. `browserCredential()` returns a verified `Credential`;
  `session.credential()` provides access to it. The session handles cancellation,
  sign-out, and disposal.
- `login/` owns the login experience: pending state, cancellation, retry, email
  display, and sign-out.
- `agents/` lists the signed-in account's remote agents beneath login, with
  refresh and retry. Settings directs people to the **Agents** tab to create,
  edit instructions and delete agents. Listing does not activate agents or
  publish community registrations. Requests reuse the OAuth credential through
  native host HTTP; sign-out and navigation discard late results.
  The client also supplies the hosted adapter's Beekeeper operations. Pending
  registration UUIDs survive restart, scoped to server, verified account and
  name. Retry the same name after an uncertain failure within the server's
  seven-day replay window. Instructions are limited to 20,000 characters,
  affect newly accepted tasks and are never published to the relay.
- `known-communities/` keeps the account's community list in step with this
  device through the `knownCommunities` capability while signed in, in native
  builds with a configured service: it checks that the account is bound to this
  device's key (never binding it), merges the service's complete list, uploads
  queued joins and leaves one destination head at a time with retries under the
  same operation ID, and reports its state for the rail's not-synced indicator.
  See [communities](../../../docs/communities.md#known-communities).

The plugin uses the `BUZZ_BUILDERLAB_URL` [build input](../../../docs/configuration.md#builderlab-url-build-input)
as its server address and appends `/api/goose`.

On desktop, the plugin supplies `/v1/auth/login` with `type=cli` and
`product=builderlab` to the shared native
[`oauth_callback` module](../../../src-tauri/src/oauth_callback/README.md).
Native code inserts a loopback `redirect_uri` address, opens the browser, and returns
callback parameters to the plugin. Native code generates and validates OAuth
state; the plugin also uses a random callback path.

Each attempt generates a random PKCE verifier held only in memory, sending its
SHA-256 challenge with `code_challenge_method=S256` during login. The plugin
posts the callback code and `code_verifier` to `/v1/auth/login/exchange`, then
verifies the returned session credential with `/v1/auth/me` using the
`X-BB-Session-Credential` header. These requests use the shared host transport.
