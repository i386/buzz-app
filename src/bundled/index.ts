import voiceNotesManifest from "./voice-notes/manifest.json";
import * as voiceNotes from "./voice-notes";
import pairingManifest from "./pairing/manifest.json";
import * as pairing from "./pairing";
import todosManifest from "./todos/manifest.json";
import builderlabManifest from "./builderlab/manifest.json";
import * as builderlab from "./builderlab";
import * as todos from "./todos";
import diffsManifest from "./diffs/manifest.json";
import * as diffs from "./diffs";
import namingManifest from "./identity-naming/manifest.json";
import * as naming from "./identity-naming";
import feedbackManifest from "./feedback/manifest.json";
import * as feedback from "./feedback";
import activityManifest from "./agent-activity/manifest.json";
import * as activity from "./agent-activity";
import terminalManifest from "./terminal/manifest.json";
import * as terminal from "./terminal";
import profilesManifest from "./profiles/manifest.json";
import * as profiles from "./profiles";
import mentionsManifest from "./mentions/manifest.json";
import * as mentions from "./mentions";
import emojiManifest from "./emoji/manifest.json";
import * as emoji from "./emoji";
import agentsManifest from "./agents/manifest.json";
import * as agents from "./agents";
import claudeCodeManifest from "./claude-code/manifest.json";
import * as claudeCode from "./claude-code";
import codexManifest from "./codex/manifest.json";
import * as codex from "./codex";
import gooseManifest from "./goose/manifest.json";
import * as goose from "./goose";
import databricksManifest from "./databricks/manifest.json";
import * as databricks from "./databricks";
import channelsManifest from "./channels/manifest.json";
import usageManifest from "./channel-usage/manifest.json";
import * as usage from "./channel-usage";
import githubManifest from "./github/manifest.json";
import * as channels from "./channels";
import * as github from "./github";
import bestieManifest from "./bestie/manifest.json";
import * as bestie from "./bestie";
import meManifest from "./me/manifest.json";
import * as me from "./me";
import inboxManifest from "./inbox/manifest.json";
import * as inbox from "./inbox";
import remindersManifest from "./reminders/manifest.json";
import * as reminders from "./reminders";
import projectsManifest from "./projects/manifest.json";
import * as projects from "./projects";
import workflowsManifest from "./workflows/manifest.json";
import * as workflows from "./workflows";
import type { BundledPlugin } from "../plugins/manager";
import linksManifest from "./links/manifest.json";
import * as links from "./links";
import hostedManifest from "./hosted-communities/manifest.json";
import * as hosted from "./hosted-communities";
import sessionsManifest from "./sessions/manifest.json";
import * as sessions from "./sessions";
import moderationManifest from "./moderation/manifest.json";
import * as moderation from "./moderation";

export const bundledPlugins: readonly BundledPlugin[] = [
  {
    manifest: { ...databricksManifest, apiVersion: 1 },
    module: databricks,
    enabledByDefault: true,
  },
  {
    manifest: { ...voiceNotesManifest, apiVersion: 1 },
    module: voiceNotes,
    enabledByDefault: true,
  },
  {
    manifest: { ...meManifest, apiVersion: 1 },
    module: me,
    enabledByDefault: true,
  },
  {
    manifest: { ...builderlabManifest, apiVersion: 1 },
    module: builderlab,
    enabledByDefault: true,
  },
  {
    manifest: { ...pairingManifest, apiVersion: 1 },
    module: pairing,
    enabledByDefault: true,
  },
  {
    manifest: { ...feedbackManifest, apiVersion: 1 },
    module: feedback,
    enabledByDefault: true,
  },
  {
    manifest: { ...todosManifest, apiVersion: 1 },
    module: todos,
    enabledByDefault: false,
  },
  {
    manifest: { ...diffsManifest, apiVersion: 1 },
    module: diffs,
    enabledByDefault: true,
  },
  {
    manifest: { ...namingManifest, apiVersion: 1 },
    module: naming,
    enabledByDefault: true,
  },
  {
    manifest: { ...activityManifest, apiVersion: 1 },
    module: activity,
    enabledByDefault: true,
  },
  {
    manifest: { ...terminalManifest, apiVersion: 1 },
    module: terminal,
    enabledByDefault: true,
  },
  {
    manifest: { ...profilesManifest, apiVersion: 1 },
    module: profiles,
    enabledByDefault: true,
  },
  {
    manifest: { ...linksManifest, apiVersion: 1 },
    module: links,
    enabledByDefault: true,
  },
  {
    manifest: { ...mentionsManifest, apiVersion: 1 },
    module: mentions,
    enabledByDefault: true,
  },
  {
    manifest: { ...emojiManifest, apiVersion: 1 },
    module: emoji,
    enabledByDefault: true,
  },
  {
    manifest: { ...channelsManifest, apiVersion: 1 },
    module: channels,
    enabledByDefault: true,
  },
  {
    manifest: { ...usageManifest, apiVersion: 1 },
    module: usage,
    enabledByDefault: true,
  },
  {
    manifest: { ...githubManifest, apiVersion: 1 },
    module: github,
    enabledByDefault: true,
  },
  {
    manifest: { ...bestieManifest, apiVersion: 1 },
    module: bestie,
    enabledByDefault: false,
  },
  {
    manifest: { ...inboxManifest, apiVersion: 1 },
    module: inbox,
    enabledByDefault: true,
  },
  {
    manifest: { ...remindersManifest, apiVersion: 1 },
    module: reminders,
    enabledByDefault: true,
  },
  {
    manifest: { ...projectsManifest, apiVersion: 1 },
    module: projects,
    enabledByDefault: true,
  },
  {
    manifest: { ...agentsManifest, apiVersion: 1 },
    module: agents,
    enabledByDefault: true,
  },
  {
    manifest: { ...claudeCodeManifest, apiVersion: 1 },
    module: claudeCode,
    enabledByDefault: true,
  },
  {
    manifest: { ...codexManifest, apiVersion: 1 },
    module: codex,
    enabledByDefault: true,
  },
  {
    manifest: { ...gooseManifest, apiVersion: 1 },
    module: goose,
    enabledByDefault: true,
  },
  {
    manifest: { ...workflowsManifest, apiVersion: 1 },
    module: workflows,
    enabledByDefault: true,
  },
  {
    manifest: { ...sessionsManifest, apiVersion: 1 },
    module: sessions,
    enabledByDefault: true,
  },
  {
    manifest: { ...hostedManifest, apiVersion: 1 },
    module: hosted,
    enabledByDefault: true,
  },
  {
    manifest: { ...moderationManifest, apiVersion: 1 },
    module: moderation,
    enabledByDefault: true,
  },
];
