// The card's look is a stated requirement, so the parts of it that can be checked are checked here.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CARD_HTML } from "../src/ui/cardHtml.generated";

const css = readFileSync(join(process.cwd(), "ui/cards.css"), "utf8").replace(/\r\n/g, "\n");

function token(name: string, scheme: "light" | "dark"): string {
  const m = new RegExp(`--${name}:\\s*([^;]+);`).exec(css);
  if (!m) throw new Error(`no --${name}`);
  const pair = /^light-dark\((#[0-9a-f]{6}),\s*(#[0-9a-f]{6})\)$/i.exec(m[1].trim());
  if (pair) return scheme === "light" ? pair[1] : pair[2];
  return m[1].trim();
}

function luminance(hex: string): number {
  const channel = (i: number) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe("original demo palette", () => {
  it("uses the original values for the light theme", () => {
    const original = {
      paper: "#ffffff",
      ink: "#17151f",
      muted: "#686577",
      mist: "#f6f4f3",
      line: "#e8e5e3",
      "line-strong": "#d4d0cd",
      accent: "#6b55e8",
      "accent-strong": "#5843d6",
      "accent-soft": "#f0edfd",
      sand: "#f5efe0",
      "sand-ink": "#6e5a2c",
      good: "#2f6b45",
      "good-soft": "#e8f2ea",
      warn: "#8a5a0b",
      "warn-soft": "#fbf1dc",
      bad: "#a33b2b",
      "bad-soft": "#fbeae6",
      info: "#2f5a8a",
      "info-soft": "#e8f0f8",
    };
    for (const [name, value] of Object.entries(original)) expect(token(name, "light"), name).toBe(value);
  });

  it("the test teal is gone from the built card", () => {
    expect(CARD_HTML.toLowerCase()).not.toContain("0e6e66");
    expect(CARD_HTML).toContain("#6b55e8");
  });

  it("does not take colors from the host, so the card looks the same everywhere", () => {
    expect(css).not.toMatch(/var\(--color-/);
  });
});

describe("readable in both themes", () => {
  const TEXT_ON: Array<[string, string]> = [
    ["ink", "paper"],
    ["muted", "paper"],
    ["ink", "mist"],
    ["muted", "mist"],
    ["accent-ink", "paper"],
    ["on-accent", "accent"],
    ["on-accent", "accent-strong"],
    ["sand-ink", "sand"],
    ["good", "good-soft"],
    ["warn", "warn-soft"],
    ["bad", "bad-soft"],
    ["info", "info-soft"],
    ["bad", "paper"],
  ];
  it.each(["light", "dark"] as const)("%s: every text pairing reaches 4.5:1", (scheme) => {
    for (const [fg, bg] of TEXT_ON) {
      const ratio = contrast(token(fg, scheme), token(bg, scheme));
      expect(ratio, `${fg} on ${bg}: ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe("usable without a pointer or a large screen", () => {
  it("buttons and disclosures keep a 44px target and a visible keyboard focus", () => {
    expect(css).toMatch(/\.btn \{[^}]*min-height: 44px/);
    expect(css).toMatch(/\.details summary \{[^}]*min-height: 44px/);
    expect(css).toMatch(/\.draft summary \{[^}]*min-height: 44px/);
    expect(css).toMatch(/:is\(\.btn, summary\):focus-visible \{[^}]*outline: 2px solid/);
  });

  it("adapts to light and dark, and respects reduced motion", () => {
    expect(css).toContain("color-scheme: light dark;");
    expect(css).toContain("light-dark(");
    expect(css).toContain("prefers-reduced-motion: reduce");
  });
});
