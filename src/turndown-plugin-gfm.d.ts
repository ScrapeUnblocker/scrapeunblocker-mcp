// turndown-plugin-gfm ships no types; only the GFM bundle is used.
declare module "turndown-plugin-gfm" {
  import type TurndownService from "turndown";
  export const gfm: TurndownService.Plugin;
}
