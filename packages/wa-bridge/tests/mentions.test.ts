import { describe, expect, test } from "bun:test";
import { cleanMentionText, extractMentions } from "../src/mentions.ts";

describe("extractMentions", () => {
  test("extracts phone numbers prefixed with @ from text", () => {
    const text = "Reminder untuk @628123456789 besok jam 9 pagi";
    const mentions = extractMentions(text);
    expect(mentions).toEqual(["628123456789@s.whatsapp.net"]);
  });

  test("extracts full JIDs from text", () => {
    const text = "cc @100000000000001@lid dan @62899999999@s.whatsapp.net";
    const mentions = extractMentions(text);
    expect(mentions).toContain("100000000000001@lid");
    expect(mentions).toContain("62899999999@s.whatsapp.net");
  });

  test("combines explicit mentions with text mentions without duplicates", () => {
    const text = "halo @628123456789";
    const explicit = ["628123456789@s.whatsapp.net", "628999999999@s.whatsapp.net"];
    const mentions = extractMentions(text, explicit);
    expect(mentions).toEqual(["628123456789@s.whatsapp.net", "628999999999@s.whatsapp.net"]);
  });

  test("a number at the end of a sentence is still a tag", () => {
    expect(extractMentions("tolong cek, @628123456789.")).toEqual(["628123456789@s.whatsapp.net"]);
    expect(extractMentions("@628123456789!")).toEqual(["628123456789@s.whatsapp.net"]);
  });

  test("not every @ and digits is a person: too short or too long for a phone, inside an address, or run into a word", () => {
    // Each of these would otherwise go out as a mention of a JID nobody owns — or, for a short one, of somebody's real
    // number by accident.
    expect(extractMentions("rapat @123456 di lantai 2")).toEqual([]);
    expect(extractMentions("kirim ke @1234567890123456")).toEqual([]);
    expect(extractMentions("email mira@628123456789 saja")).toEqual([]);
    expect(extractMentions("kode @628123456789abc")).toEqual([]);
    // The bounds themselves: seven and fifteen digits are numbers WhatsApp has.
    expect(extractMentions("@1234567 @123456789012345")).toEqual(["1234567@s.whatsapp.net", "123456789012345@s.whatsapp.net"]);
  });
});

describe("cleanMentionText", () => {
  test("strips @lid domain suffix from mention tags", () => {
    const text = "@100000000000001@lid Jangan lupa jemput Kak Mira!";
    expect(cleanMentionText(text)).toBe("@100000000000001 Jangan lupa jemput Kak Mira!");
  });

  test("strips @s.whatsapp.net domain suffix from mention tags", () => {
    const text = "cc @628123456789@s.whatsapp.net tolong cek ini";
    expect(cleanMentionText(text)).toBe("cc @628123456789 tolong cek ini");
  });

  test("leaves plain @number tags untouched", () => {
    const text = "halo @628123456789 selamat pagi";
    expect(cleanMentionText(text)).toBe("halo @628123456789 selamat pagi");
  });
});
