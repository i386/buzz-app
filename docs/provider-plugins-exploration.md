# Shared provider plugins for Goose and Pi

Goose and Pi can use several inference providers. Their credentials belong to the selected provider, rather than a single harness account such as the one used by Codex or Claude. A shared provider plugin would let a user configure Databricks or OpenRouter once and use that connection from either agent type.

## Motivation

In the Buzz discussions, Mic asked how general-purpose harnesses could share providers, and baxen proposed configuring credentials once for Goose and Pi. The proposed scope became credentials plus model discovery. This would avoid separate logins and duplicate configuration while giving Buzz one model picker across configured providers. See the [provider registry discussion](buzz://message?channel=099e2481-9499-48d6-adad-fa89a15163a0&id=385f6dae4cdf5e455a3ca506e8c96ee270b86198b053547d47a87587534f2514) and [shared provider proposal](buzz://message?channel=099e2481-9499-48d6-adad-fa89a15163a0&id=0cba713c360bf4b5310cd717df4868e8e6e0b644dfcf69f424645b64da8960ae).

## Scope

Provider integration involves three kinds of work:

1. **Authentication and configuration:** credentials, endpoints, login, and token refresh.

2. **Model discovery:** model IDs, aliases, available API routes, and capabilities.

3. **Inference:** request formatting, streaming, thinking controls, and conversation replay.

Share the first two. Leave inference to each agent plugin’s harness integration. Goose and Pi have different request and history representations; their existing adapters already translate those into provider APIs. The [Pi Databricks extension](https://github.com/squareup/pi-extensions/tree/main/packages/pi-databricks) also contains Pi-specific compatibility fixes that a shared catalog cannot replace.

## Databricks example and boundaries

A user configures **Work Databricks**, signs in once, and chooses a model. The shared plugin supplies the connection and catalog. The Pi integration loads its Databricks extension; the Goose integration configures a supported Goose provider adapter. Each uses a supported API route and obtains current access tokens from the shared authentication owner.

| Shared Databricks plugin owns | Each agent plugin integration owns |
| --- | --- |
| Workspace configuration and connection identity | Binding an agent to a connection and served model ID |
| Login, credential storage, and token refresh | Obtaining fresh access tokens while sessions remain running |
| Endpoint and alias discovery | Registering the catalog with its harness |
| Available API routes and provider capability facts | Filtering unsupported routes and mapping model and effort choices |
| Shared authentication and discovery status | Request formatting, streaming, history replay, and harness-specific compatibility fixes |

The picker can lead with the model and show “via Work Databricks” underneath. Save the exact connection and served model ID. A model appearing in the shared catalog does not imply that both harnesses support it; each integration must check compatibility.

## First slice: Databricks for Goose

Add one shared connection to Block’s Databricks workspace, with browser login, private local credential storage, token refresh, and discovery. Goose selects that connection and an exact served model ID. Pi and OpenRouter can follow after this boundary works.

Goose’s native Databricks adapter does not accept an external credential callback. For this slice, the Goose integration generates a custom OpenAI adapter configuration with command auth. A small Buzz native helper supplies current access tokens; refresh tokens stay in the provider’s private local storage. File locking serializes refresh across Goose processes. Request formatting and streaming remain in Goose.

Goose uses the gateway’s Responses route. Its Chat route rejects reasoning effort alongside tools for GPT-6 models, and GPT-6.1 Sol always requires reasoning effort. Goose offers a short list of ready, tool-capable endpoints that were verified with its tools: GPT-6 and 6.1, Claude Opus, Sonnet, and Haiku 5.5, GLM 5.3, and Grok 4.7. Gemini rejects Goose’s streaming options, and Gemma rejects a tool-schema keyword. Other models, aliases, workspace configuration, and per-agent thinking controls are deferred; Goose’s own thinking-effort setting applies.

The generated Goose configuration contains no tokens and uses its usual history store. Cancellation applies while waiting for the browser. Once the callback has been accepted, the UI shows “Completing sign-in…” while native code saves the connection.

Try it by enabling Databricks and Goose, opening **Settings → Providers → Databricks**, signing in, then choosing **Databricks in Buzz** in a Goose agent’s provider dialog. Verify a tool-bearing conversation, two agents using the same connection, history after restart, and continued work after token refresh.
