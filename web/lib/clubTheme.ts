// Club colour themes, keyed off `teams.short_name` (the 3-letter FPL code).
// Consumed by <ClubBadge>. Any code not in the map falls back to neutral slate,
// so a mid-season promoted side still renders sensibly.

export interface ClubTheme {
  /** Circle fill. */
  primary: string;
  /** Thin secondary arc / underline. */
  secondary: string;
  /** 3-letter code colour — must read on `primary`. */
  text: string;
}

export const FALLBACK_CLUB_THEME: ClubTheme = {
  primary: "#3A465A",
  secondary: "#FFFFFF",
  text: "#FFFFFF",
};

// Keys are `teams.short_name`. A few historic/alternate codes (MNU↔MUN) are
// aliased so we match whatever the FPL bootstrap returns.
export const CLUB_THEME: Record<string, ClubTheme> = {
  ARS: { primary: "#EF0107", secondary: "#FFFFFF", text: "#FFFFFF" },
  AVL: { primary: "#670E36", secondary: "#95BFE5", text: "#FFFFFF" },
  BOU: { primary: "#DA291C", secondary: "#000000", text: "#FFFFFF" },
  BRE: { primary: "#E30613", secondary: "#FFFFFF", text: "#FFFFFF" },
  BHA: { primary: "#0057B8", secondary: "#FFCD00", text: "#FFFFFF" },
  BUR: { primary: "#6C1D45", secondary: "#99D6EA", text: "#FFFFFF" },
  CHE: { primary: "#034694", secondary: "#FFFFFF", text: "#FFFFFF" },
  COV: { primary: "#059DD9", secondary: "#FFFFFF", text: "#FFFFFF" },
  CRY: { primary: "#1B458F", secondary: "#C4122E", text: "#FFFFFF" },
  EVE: { primary: "#003399", secondary: "#FFFFFF", text: "#FFFFFF" },
  FUL: { primary: "#FFFFFF", secondary: "#000000", text: "#111111" },
  HUL: { primary: "#F18A01", secondary: "#000000", text: "#000000" },
  IPS: { primary: "#0E63AD", secondary: "#FFFFFF", text: "#FFFFFF" },
  LEE: { primary: "#1D428A", secondary: "#FFCD00", text: "#FFFFFF" },
  LEI: { primary: "#003090", secondary: "#FDBE11", text: "#FFFFFF" },
  LIV: { primary: "#C8102E", secondary: "#00B2A9", text: "#FFFFFF" },
  LUT: { primary: "#F78F1E", secondary: "#002D62", text: "#111111" },
  MCI: { primary: "#6CABDD", secondary: "#1C2C5B", text: "#0A2138" },
  MNU: { primary: "#DA291C", secondary: "#FBE122", text: "#FFFFFF" },
  MUN: { primary: "#DA291C", secondary: "#FBE122", text: "#FFFFFF" },
  NEW: { primary: "#241F20", secondary: "#FFFFFF", text: "#FFFFFF" },
  NFO: { primary: "#DD0000", secondary: "#FFFFFF", text: "#FFFFFF" },
  NOR: { primary: "#00A650", secondary: "#FFF200", text: "#FFFFFF" },
  SHU: { primary: "#EE2737", secondary: "#FFFFFF", text: "#FFFFFF" },
  SOU: { primary: "#D71920", secondary: "#FFFFFF", text: "#FFFFFF" },
  SUN: { primary: "#EB172B", secondary: "#211E1F", text: "#FFFFFF" },
  TOT: { primary: "#132257", secondary: "#FFFFFF", text: "#FFFFFF" },
  WHU: { primary: "#7A263A", secondary: "#1BB1E7", text: "#FFFFFF" },
  WOL: { primary: "#FDB913", secondary: "#231F20", text: "#231F20" },
};

/** Resolve a club theme by short_name, falling back to neutral slate. */
export function clubTheme(shortName: string | null | undefined): ClubTheme {
  if (!shortName) return FALLBACK_CLUB_THEME;
  return CLUB_THEME[shortName.toUpperCase()] ?? FALLBACK_CLUB_THEME;
}
