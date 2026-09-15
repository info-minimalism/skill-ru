#!/usr/bin/env node

const fs = require("fs");

function tokenize(text) {
  const normalized = text.normalize("NFC");
  const pattern = /https?:\/\/[^\s]+|(?:www\.)?[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.[\p{L}\p{N}-]{2,}(?:\/[^\s]*)?|[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*(?:[-–—:][\p{L}\p{N}]+)*|\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*/gu;
  const matches = normalized.match(pattern) || [];
  return matches.map((token) => {
    if (/^(?:https?:\/\/|(?:www\.)?[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+)/u.test(token)) {
      return token.replace(/[.,;:!?\)\]\}]+$/u, "");
    }
    return token;
  });
}

const argumentText = process.argv.slice(2).join(" ");
const input = argumentText || fs.readFileSync(0, "utf8");
const tokens = tokenize(input);

process.stdout.write(`${JSON.stringify({ lexical_units: tokens.length, tokens }, null, 2)}\n`);
