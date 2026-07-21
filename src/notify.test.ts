import { test, expect } from "bun:test";
import type { Client } from "discord.js";
import {
  mentionPayload,
  dmOwner,
  dmOwnerEmbed,
  notificationEmbed,
  postToThread,
  LIME,
} from "./notify.js";

test("mentionPayload without a user is a plain post", () => {
  expect(mentionPayload("hello")).toEqual({ content: "hello" });
});

test("mentionPayload pings only the given user", () => {
  const p = mentionPayload("test the deploy", "owner-1");
  expect(p.content).toBe("<@owner-1> test the deploy");
  expect(p.allowedMentions).toEqual({ parse: [], users: ["owner-1"] });
});

test("dmOwner returns false and sends nothing when no owner is set", async () => {
  let fetched = false;
  const client = { users: { fetch: async () => ((fetched = true), {}) } } as unknown as Client;
  expect(await dmOwner(client, undefined, "hi")).toBe(false);
  expect(fetched).toBe(false);
});

test("dmOwner sends a direct message to the owner", async () => {
  const sent: string[] = [];
  const client = {
    users: { fetch: async (id: string) => ({ id, send: async (t: string) => sent.push(t) }) },
  } as unknown as Client;
  expect(await dmOwner(client, "owner-1", "⏰ reminder")).toBe(true);
  expect(sent).toEqual(["⏰ reminder"]);
});

test("dmOwner swallows failures and reports false", async () => {
  const client = {
    users: { fetch: async () => { throw new Error("cannot DM"); } },
  } as unknown as Client;
  expect(await dmOwner(client, "owner-1", "hi")).toBe(false);
});

test("notificationEmbed uses lime, a source-labelled author, and the message body", () => {
  const embed = notificationEmbed("**build** passed", "rust-academy", "2026-07-21T10:00:00Z");
  expect(embed.data.color).toBe(LIME);
  expect(embed.data.author?.name).toBe("📨 rust-academy");
  expect(embed.data.description).toBe("**build** passed");
  expect(embed.data.timestamp).toBe("2026-07-21T10:00:00.000Z");
});

test("notificationEmbed falls back to a generic author without a source label", () => {
  const embed = notificationEmbed("hi");
  expect(embed.data.author?.name).toBe("📨 New message");
  expect(embed.data.timestamp).toBeUndefined();
});

test("notificationEmbed ignores an unparseable createdAt", () => {
  const embed = notificationEmbed("hi", "cron", "not-a-date");
  expect(embed.data.timestamp).toBeUndefined();
});

test("dmOwnerEmbed sends the embed to the owner", async () => {
  const sent: unknown[] = [];
  const client = {
    users: { fetch: async (id: string) => ({ id, send: async (p: unknown) => sent.push(p) }) },
  } as unknown as Client;
  const embed = notificationEmbed("hi", "cron");
  expect(await dmOwnerEmbed(client, "owner-1", embed)).toBe(true);
  expect(sent).toEqual([{ embeds: [embed] }]);
});

test("dmOwnerEmbed returns false when no owner is set", async () => {
  let fetched = false;
  const client = { users: { fetch: async () => ((fetched = true), {}) } } as unknown as Client;
  expect(await dmOwnerEmbed(client, undefined, notificationEmbed("hi"))).toBe(false);
  expect(fetched).toBe(false);
});

test("dmOwnerEmbed swallows failures and reports false", async () => {
  const client = {
    users: { fetch: async () => { throw new Error("cannot DM"); } },
  } as unknown as Client;
  expect(await dmOwnerEmbed(client, "owner-1", notificationEmbed("hi"))).toBe(false);
});

test("postToThread posts with an owner ping and unarchives first", async () => {
  const calls: { setArchived?: boolean; send?: unknown } = {};
  const thread = {
    isThread: () => true,
    archived: true,
    setArchived: async (v: boolean) => { calls.setArchived = v; },
    send: async (payload: unknown) => { calls.send = payload; },
  };
  const client = { channels: { fetch: async () => thread } } as unknown as Client;
  expect(await postToThread(client, "t-1", "test", "owner-1")).toBe(true);
  expect(calls.setArchived).toBe(false);
  expect(calls.send).toEqual({
    content: "<@owner-1> test",
    allowedMentions: { parse: [], users: ["owner-1"] },
  });
});

test("postToThread returns false for a non-thread or missing channel", async () => {
  const missing = { channels: { fetch: async () => null } } as unknown as Client;
  expect(await postToThread(missing, "t-1", "x")).toBe(false);
  const notThread = {
    channels: { fetch: async () => ({ isThread: () => false }) },
  } as unknown as Client;
  expect(await postToThread(notThread, "t-1", "x")).toBe(false);
});
