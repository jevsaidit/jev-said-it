// Words the site uses for a verdict, in one place, so the title, the card, the panel row and the
// post text cannot disagree with each other.

export const pct = (p: number) => `${Math.round(p * 100)}%`;

/** "64% up" or "65% down": a probability below one half is a call on the price going down. */
export const said = (p: number) => (p >= 0.5 ? `${pct(p)} up` : `${pct(1 - p)} down`);

/** The engine's model ids look like `typesafe/jev-1.13.0`; anything else is the fallback (spec §8). */
export const isJev = (model: string | undefined | null) => /jev/i.test(model ?? "");

/** Who answered, for a label: "Jev", or the fallback's name so it is never published as Jev's. */
export const whoSaid = (model: string | undefined | null) => (isJev(model) ? "Jev" : `${model || "unknown model"} (fallback)`);
